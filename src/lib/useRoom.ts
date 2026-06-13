// Orchestrates a joined room: presence registration, history load, realtime
// transport, optimistic sends, reactions, typing, pruning and deletion. All
// encryption/decryption happens here or in the helpers it calls.
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { decryptString, encryptString } from "@shared/crypto"
import type { PublicRoomState, StoredMessage } from "@shared/types"
import { api, ApiError } from "./api"
import { Realtime, type ConnState } from "./realtime"
import { aad, type RoomSession } from "./session"
import { randomId } from "./clientCrypto"
import {
  decodeMessage,
  decodeTopic,
  encodeDecoy,
  encodeMedia,
  encodeReaction,
  encodeText,
  encodeTopic,
  reactionId as makeReactionId,
  type DecryptedMessage,
  type ReplyRef,
} from "./messages"
import { encryptAndUpload, type MediaManifestItem, type UploadStatus } from "./media"
import { vault } from "./vault"
import { ensureNotificationPrompt, notificationsEnabled, showMessageNotification } from "./notify"
import { subscribePush } from "./push"

export interface TypingUser {
  participantId: string
  username: string
  at: number
}

export interface UploadState {
  id: string
  filename: string
  status: UploadStatus
  progress: number
}

/** Per-message send options: disappearing timer, read-once, and reply ref. */
export interface SendOpts {
  ttlMs?: number
  burn?: boolean
  replyTo?: ReplyRef
}

export interface RoomController {
  messages: DecryptedMessage[]
  connState: ConnState
  participantCount: number
  room: PublicRoomState | null
  /** Decrypted room topic/name ("" when unset). */
  topic: string
  /** True when this device holds the owner secret for the room. */
  isOwner: boolean
  /** True once the owner has removed (banned) this participant. */
  bannedSelf: boolean
  /** Whether cover-traffic (decoy messages) is currently being emitted. */
  decoyEnabled: boolean
  typing: TypingUser[]
  othersSeenUpTo: number
  /** participantId -> latest message timestamp that peer has read (per-person receipts). */
  seenBy: Record<string, number>
  /** participantId -> best-known display name, for rendering read receipts. */
  names: Record<string, string>
  uploads: UploadState[]
  error: string | null
  deleted: boolean
  sendText: (text: string, opts?: SendOpts) => Promise<void>
  sendMedia: (files: File[], caption: string, opts?: SendOpts) => Promise<void>
  retrySend: (id: string) => Promise<void>
  editMessage: (id: string, text: string) => Promise<void>
  deleteMessage: (id: string) => Promise<void>
  markSeen: (lastSeen: number) => void
  toggleReaction: (messageId: string, emoji: string) => Promise<void>
  prune: (ids: string[]) => Promise<void>
  pruneAll: () => Promise<void>
  wipeLocal: () => void
  deleteRoom: () => Promise<void>
  notifyTyping: () => void
  rename: (name: string) => void
  /** Owner-only: set (or clear, with "") the encrypted room topic. */
  setTopic: (topic: string) => Promise<void>
  /** Owner-only: ban a participant by id (server-enforced). */
  banMember: (participantId: string) => Promise<void>
  /** Owner-only: lift a ban. */
  unbanMember: (participantId: string) => Promise<void>
  /** Toggle cover-traffic emission on/off. */
  toggleDecoy: () => void
}

function participantAuth(session: RoomSession) {
  return {
    participantId: session.participantId,
    participantProof: session.participantProof,
  }
}

export function useRoom(session: RoomSession): RoomController {
  const [messages, setMessages] = useState<DecryptedMessage[]>([])
  const [connState, setConnState] = useState<ConnState>("connecting")
  const [participantCount, setParticipantCount] = useState(1)
  const [room, setRoom] = useState<PublicRoomState | null>(null)
  const [topic, setTopicState] = useState("")
  const [bannedSelf, setBannedSelf] = useState(false)
  const [decoyEnabled, setDecoyEnabled] = useState(
    () => !!vault.get(session.invite.roomId)?.decoyEnabled,
  )
  const [typing, setTyping] = useState<TypingUser[]>([])
  const [othersSeenUpTo, setOthersSeenUpTo] = useState(0)
  const [seenBy, setSeenBy] = useState<Record<string, number>>({})
  const [names, setNames] = useState<Record<string, string>>({})
  const [uploads, setUploads] = useState<UploadState[]>([])
  const [error, setError] = useState<string | null>(null)
  const [deleted, setDeleted] = useState(false)

  // This device owns the room iff it holds the owner secret (set at creation or
  // imported via multi-device sync). The server independently verifies the
  // secret on every owner action, so this only governs which controls we show.
  const isOwner = !!session.ownerSecret

  const storedById = useRef(new Map<string, StoredMessage>())
  // Cache of already-decrypted messages keyed by id. Avoids re-running AES-GCM
  // over the entire history on every send/receive (the old hot path that made
  // sending feel slow as the room grew). A cache entry is reused only while the
  // underlying stored object is unchanged (reactions create a new object).
  const decodeCache = useRef(new Map<string, { src: StoredMessage; out: DecryptedMessage }>())
  // Optimistic, not-yet-acknowledged outgoing messages. Removed once the server
  // echoes the same id back into storedById.
  const pendingById = useRef(new Map<string, DecryptedMessage>())
  // Original File objects for in-flight/failed media sends, keyed by message id,
  // so a failed upload can be retried in place (same id, no duplicate).
  const pendingMediaById = useRef(
    new Map<string, { files: File[]; caption: string; opts?: SendOpts }>(),
  )
  // Client-only system notices (join/leave). Never sent to or stored on server.
  const noticesRef = useRef<DecryptedMessage[]>([])
  // Live display-name overrides keyed by participantId, applied on top of the
  // names baked into past envelopes so a mid-session rename shows consistently.
  const nameOverrides = useRef(new Map<string, string>())
  // First-seen Ed25519 signing key per participant (trust-on-first-use). Used to
  // flag a sender whose signing key later changes mid-session.
  const signerKeys = useRef(new Map<string, string>())
  const prevCountRef = useRef<number | null>(null)
  const rt = useRef<Realtime | null>(null)
  const sinceRef = useRef(0)
  const lastTypingSent = useRef(0)
  const lastSeenSent = useRef(0)

  const recompute = useCallback(async () => {
    const all = Array.from(storedById.current.values()).sort((a, b) => a.createdAt - b.createdAt)
    const liveIds = new Set<string>()
    const decoded = await Promise.all(
      all.map(async (m) => {
        liveIds.add(m.id)
        const cached = decodeCache.current.get(m.id)
        if (cached && cached.src === m) return cached.out
        const out = await decodeMessage(session, m)
        decodeCache.current.set(m.id, { src: m, out })
        return out
      }),
    )
    // Evict cache + optimistic entries that no longer apply.
    for (const key of Array.from(decodeCache.current.keys())) {
      if (!liveIds.has(key)) decodeCache.current.delete(key)
    }
    for (const id of Array.from(pendingById.current.keys())) {
      if (storedById.current.has(id)) pendingById.current.delete(id)
    }
    for (const id of Array.from(pendingMediaById.current.keys())) {
      if (storedById.current.has(id)) pendingMediaById.current.delete(id)
    }
    const pending = Array.from(pendingById.current.values())
    const merged = [...decoded, ...pending, ...noticesRef.current].sort(
      (a, b) => a.createdAt - b.createdAt,
    )
    // Single ordered pass: drop cover-traffic decoys (never shown), then apply
    // live nickname overrides and trust-on-first-use signing-key pinning. Both
    // produce new objects so cached decode results are never mutated. Iterating
    // in chronological order means the earliest key we see for a participant
    // becomes the pinned one; a later mismatch is flagged.
    const final = merged
      .filter((m) => !m.decoy)
      .map((m) => {
        let out = m
        const o = nameOverrides.current.get(m.participantId)
        if (o && m.kind !== "system" && m.username !== o) out = { ...out, username: o }
        if (m.kind !== "system" && m.verified === "ok" && m.signerKey) {
          const pinned = signerKeys.current.get(m.participantId)
          if (!pinned) signerKeys.current.set(m.participantId, m.signerKey)
          else if (pinned !== m.signerKey) out = out === m ? { ...m, keyChanged: true } : { ...out, keyChanged: true }
        }
        return out
      })
    setMessages(final)
    // Build a best-known name map (from baked-in usernames, with live overrides
    // winning) so per-person read receipts can show real names.
    const nameMap: Record<string, string> = {}
    for (const m of final) {
      if (m.kind !== "system" && m.username && m.username !== "anon") nameMap[m.participantId] = m.username
    }
    for (const [pid, nm] of nameOverrides.current) nameMap[pid] = nm
    setNames(nameMap)
    sinceRef.current = all.reduce((mx, m) => Math.max(mx, m.createdAt), sinceRef.current)
  }, [session])

  const pushNotice = useCallback(
    (text: string) => {
      const notice: DecryptedMessage = {
        id: "notice-" + randomId(8),
        participantId: "system",
        kind: "system",
        createdAt: Date.now(),
        expiresAt: null,
        mine: false,
        username: "",
        text,
        reactions: [],
      }
      noticesRef.current = [...noticesRef.current, notice].slice(-40)
      void recompute()
    },
    [recompute],
  )

  // Apply a fresh public room snapshot: store it and (re)decrypt the topic. The
  // topic envelope is opaque to the server; only members with the key can read
  // it. Used both on initial load and on every "room-updated" realtime frame.
  const applyRoomState = useCallback(
    (r: PublicRoomState) => {
      setRoom(r)
      if (r.topicEnvelope) {
        void decodeTopic(session, r.topicEnvelope)
          .then((t) => setTopicState(t))
          .catch(() => setTopicState(""))
      } else {
        setTopicState("")
      }
    },
    [session],
  )

  // Apply a fresh participant count. Joins are announced by name via the
  // "join" signal (see onSignal), so we only surface a generic notice when
  // someone leaves — leavers can't be named from a bare count.
  const applyPresence = useCallback(
    (count: number) => {
      setParticipantCount(count)
      const prev = prevCountRef.current
      prevCountRef.current = count
      if (prev === null || count >= prev) return
      const n = prev - count
      pushNotice(n === 1 ? "Someone left the room" : n + " people left")
    },
    [pushNotice],
  )

  const ingest = useCallback(
    (stored: StoredMessage, recomputeNow = true) => {
      storedById.current.set(stored.id, stored)
      if (recomputeNow) void recompute()
    },
    [recompute],
  )

  // mark peer activity -> drives "Seen" on my messages
  const markPeerActive = useCallback(
    (participantId: string) => {
      if (participantId !== session.participantId) setOthersSeenUpTo(Date.now())
    },
    [session.participantId],
  )

  // Surface a local OS/PWA notification for an incoming message from someone
  // else while the tab is hidden. The message is decrypted on-device and only
  // the already-visible sender name + a short preview are shown; nothing extra
  // leaves the browser. Gated on the user's pref + granted OS permission, and
  // suppressed entirely for rooms the user muted on this device.
  const maybeNotify = useCallback(
    (m: StoredMessage) => {
      if (m.participantId === session.participantId || m.kind === "system") return
      if (typeof document !== "undefined" && document.visibilityState === "visible") return
      if (!notificationsEnabled()) return
      if (vault.get(session.invite.roomId)?.muted) return
      void decodeMessage(session, m)
        .then((d) => {
          if (d.decoy) return
          const name = nameOverrides.current.get(d.participantId) || d.username || "Someone"
          const body =
            d.kind === "media"
              ? d.text?.trim() || "Sent an attachment"
              : d.text?.trim() || "New message"
          void showMessageNotification({
            title: name,
            body: body.slice(0, 140),
            tag: session.invite.roomId,
          })
        })
        .catch(() => {})
    },
    [session],
  )

  useEffect(() => {
    let cancelled = false
    async function boot() {
      try {
        await api.session({
          roomId: session.invite.roomId,
          accessProof: session.keys.accessProof,
          ...participantAuth(session),
        })
        const res = await api.listMessages({
          roomId: session.invite.roomId,
          accessProof: session.keys.accessProof,
          ...participantAuth(session),
          markReadFor: session.participantId,
        })
        if (cancelled) return
        for (const m of res.messages) storedById.current.set(m.id, m)
        applyRoomState(res.room)
        applyPresence(res.room.participantCount)
        await recompute()
      } catch (e) {
        if (!cancelled) setError(e instanceof ApiError ? e.message : "Failed to load room")
      }
    }
    void boot()

    // Arm a gesture-backed permission prompt so message notifications can be
    // enabled (browsers only prompt from a user gesture). No-op once decided.
    ensureNotificationPrompt()

    // If notifications are already enabled on this device, (re)register a Web
    // Push subscription so messages can wake the app even when it's fully closed.
    if (notificationsEnabled()) void subscribePush(session)

    const realtime = new Realtime(session, {
      onMessage: (m) => {
        markPeerActive(m.participantId)
        maybeNotify(m)
        ingest(m)
      },
      onEdit: (m) => {
        // In-place envelope swap or tombstone from a peer (or our own echo).
        // Update the stored record, drop its decode cache, and recompute
        // without notifying or reordering.
        storedById.current.set(m.id, m)
        decodeCache.current.delete(m.id)
        markPeerActive(m.participantId)
        void recompute()
      },
      onPrune: (ids, all) => {
        if (all) storedById.current.clear()
        else for (const id of ids) storedById.current.delete(id)
        void recompute()
      },
      onReact: (f) => {
        const stored = storedById.current.get(f.messageId)
        if (!stored) return
        const reactions = { ...(stored.reactions || {}) }
        if (f.envelope === null) delete reactions[f.reactionId]
        else reactions[f.reactionId] = { participantId: f.participantId, envelope: f.envelope }
        storedById.current.set(f.messageId, { ...stored, reactions })
        markPeerActive(f.participantId)
        void recompute()
      },
      onPresence: (count) => applyPresence(count),
      onSignal: (f) => {
        const ev = f.event
        markPeerActive(ev.participantId)
        if (ev.participantId === session.participantId) return
        if (ev.type === "typing" && ev.envelope) {
          void decryptString(session.channelKey, ev.envelope, aad(session, "channel"))
            .then((username) => {
              setTyping((prev) => {
                const next = prev.filter((t) => t.participantId !== ev.participantId)
                next.push({ participantId: ev.participantId, username, at: Date.now() })
                return next
              })
            })
            .catch(() => {})
        } else if (ev.type === "rename" && ev.envelope) {
          void decryptString(session.channelKey, ev.envelope, aad(session, "channel"))
            .then((raw) => {
              const name = raw.trim().slice(0, 32) || "anon"
              const prev = nameOverrides.current.get(ev.participantId)
              nameOverrides.current.set(ev.participantId, name)
              if (prev && prev !== name) pushNotice(`${prev} is now ${name}`)
              void recompute()
            })
            .catch(() => {})
        } else if (ev.type === "join" && ev.envelope) {
          void decryptString(session.channelKey, ev.envelope, aad(session, "channel"))
            .then((raw) => {
              const name = raw.trim().slice(0, 32) || "anon"
              nameOverrides.current.set(ev.participantId, name)
              pushNotice(`${name} joined the room`)
              void recompute()
            })
            .catch(() => {})
        }
      },
      onSeen: (participantId, lastSeen) => {
        if (participantId === session.participantId) return
        markPeerActive(participantId)
        setSeenBy((prev) => {
          const cur = prev[participantId] ?? 0
          if (lastSeen <= cur) return prev
          return { ...prev, [participantId]: lastSeen }
        })
      },
      onRoomUpdated: (r) => applyRoomState(r),
      onBanned: (participantId) => {
        if (participantId === session.participantId) {
          // The owner removed us: tear down realtime and surface a clear notice.
          setBannedSelf(true)
          rt.current?.stop()
        } else {
          nameOverrides.current.delete(participantId)
          pushNotice("A participant was removed by the room owner")
        }
      },
      onRoomDeleted: () => setDeleted(true),
      onState: setConnState,
      getSince: () => sinceRef.current,
    })
    rt.current = realtime
    realtime.start()

    // Announce ourselves so existing members see a named join notice. The
    // username is encrypted with the channel key; the server only relays an
    // opaque envelope. sendSignal falls back to the HTTP relay if the socket
    // isn't open yet.
    void encryptString(session.channelKey, session.username, aad(session, "channel"))
      .then((envelope) => {
        realtime.sendSignal({
          t: "signal",
          event: { type: "join", participantId: session.participantId, envelope },
        })
      })
      .catch(() => {})

    // Keep our presence fresh so the participant count (and join/leave notices)
    // stay accurate even when we are on the polling fallback. The server only
    // refreshes presence on /session, not /list.
    const heartbeat = setInterval(() => {
      void api
        .session({
          roomId: session.invite.roomId,
          accessProof: session.keys.accessProof,
          ...participantAuth(session),
        })
        .catch(() => {})
    }, 20000)

    const typingGc = setInterval(() => {
      setTyping((prev) => prev.filter((t) => Date.now() - t.at < 4000))
    }, 1500)

    return () => {
      cancelled = true
      clearInterval(heartbeat)
      clearInterval(typingGc)
      realtime.stop()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session])

  // ---------- cover traffic (decoy messages) ----------
  //
  // When enabled, periodically emit an encrypted decoy that is byte-for-byte
  // indistinguishable from a real message to the server/observers. Recipients
  // decrypt it, see the decoy flag, and silently drop it (see recompute). This
  // masks *when* and *whether* real conversation is happening. Jittered timing
  // and a short TTL keep volume modest and self-cleaning.
  useEffect(() => {
    if (!decoyEnabled) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    const tick = async () => {
      if (stopped) return
      try {
        const id = randomId()
        const envelope = await encodeDecoy(session, id)
        await api.postMessage({
          roomId: session.invite.roomId,
          accessProof: session.keys.accessProof,
          participantProof: session.participantProof,
          message: {
            id,
            participantId: session.participantId,
            envelope,
            kind: "text",
            ttlMs: 45000,
          },
        })
      } catch {
        /* a dropped decoy is harmless */
      }
      if (!stopped) timer = setTimeout(tick, 20000 + Math.random() * 40000)
    }
    timer = setTimeout(tick, 8000 + Math.random() * 12000)
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [decoyEnabled, session])

  const toggleDecoy = useCallback(() => {
    setDecoyEnabled((v) => {
      const next = !v
      vault.setDecoyEnabled(session.invite.roomId, next)
      return next
    })
  }, [session.invite.roomId])

  const sendText = useCallback(
    async (text: string, opts?: SendOpts) => {
      const trimmed = text.trim()
      if (!trimmed) return
      const id = randomId()
      const now = Date.now()
      const optimistic: DecryptedMessage = {
        id,
        participantId: session.participantId,
        kind: "text",
        createdAt: now,
        expiresAt: opts?.ttlMs ? now + opts.ttlMs : null,
        mine: true,
        username: session.username,
        text: trimmed,
        replyTo: opts?.replyTo,
        burn: opts?.burn,
        reactions: [],
        pending: true,
      }
      // Show instantly; recompute is cheap now thanks to the decode cache.
      pendingById.current.set(id, optimistic)
      void recompute()
      try {
        const envelope = await encodeText(session, id, trimmed, opts?.replyTo)
        const res = await api.postMessage({
          roomId: session.invite.roomId,
          accessProof: session.keys.accessProof,
          participantProof: session.participantProof,
          message: {
            id,
            participantId: session.participantId,
            envelope,
            kind: "text",
            ttlMs: opts?.ttlMs,
            burn: opts?.burn,
          },
        })
        ingest(res.message)
      } catch (e) {
        const p = pendingById.current.get(id)
        if (p) pendingById.current.set(id, { ...p, pending: false, failed: true })
        void recompute()
        setError(e instanceof ApiError ? e.message : "Failed to send")
      }
    },
    [session, ingest, recompute],
  )

  // Mark an optimistic message as failed so the UI offers a retry affordance.
  const markSendFailed = useCallback(
    (id: string) => {
      const p = pendingById.current.get(id)
      if (p) pendingById.current.set(id, { ...p, pending: false, failed: true })
      void recompute()
    },
    [recompute],
  )

  // Core media send used by both the first attempt and retries. Keeps the same
  // message id throughout so a retry replaces the failed bubble in place and a
  // late-landing original can't duplicate it.
  const doSendMedia = useCallback(
    async (id: string, files: File[], caption: string, opts?: SendOpts) => {
      const now = Date.now()
      const optimistic: DecryptedMessage = {
        id,
        participantId: session.participantId,
        kind: "media",
        createdAt: now,
        expiresAt: opts?.ttlMs ? now + opts.ttlMs : null,
        mine: true,
        username: session.username,
        text: caption.trim(),
        items: [],
        replyTo: opts?.replyTo,
        burn: opts?.burn,
        reactions: [],
        pending: true,
      }
      pendingById.current.set(id, optimistic)
      pendingMediaById.current.set(id, { files, caption, opts })
      void recompute()

      const items: MediaManifestItem[] = []
      const refs = []
      for (const file of files) {
        const uploadId = randomId(6)
        setUploads((prev) => [
          ...prev,
          { id: uploadId, filename: file.name, status: "encrypting", progress: 0 },
        ])
        try {
          const { ref, manifest } = await encryptAndUpload(session, file, (status, progress) =>
            setUploads((prev) =>
              prev.map((u) => (u.id === uploadId ? { ...u, status, progress: progress ?? u.progress } : u)),
            ),
          )
          items.push(manifest)
          refs.push(ref)
        } catch (e) {
          markSendFailed(id)
          setError(e instanceof ApiError ? e.message : "Upload failed")
          return
        } finally {
          setTimeout(
            () => setUploads((prev) => prev.filter((u) => u.id !== uploadId)),
            1500,
          )
        }
      }
      // Keep the encrypted envelope comfortably under the server size cap: the
      // manifest travels inside the message, and inline thumbnails are by far
      // its largest field. If the total grows too large, drop thumbs first.
      let manifestSize = JSON.stringify(items).length
      for (const it of items) {
        if (manifestSize <= 100_000) break
        if (it.thumb) {
          manifestSize -= it.thumb.length
          delete it.thumb
        }
      }
      try {
        const envelope = await encodeMedia(session, id, caption.trim(), items, opts?.replyTo)
        const res = await api.postMessage({
          roomId: session.invite.roomId,
          accessProof: session.keys.accessProof,
          participantProof: session.participantProof,
          message: {
            id,
            participantId: session.participantId,
            envelope,
            kind: "media",
            media: refs,
            ttlMs: opts?.ttlMs,
            burn: opts?.burn,
          },
        })
        pendingMediaById.current.delete(id)
        ingest(res.message)
      } catch (e) {
        markSendFailed(id)
        setError(e instanceof ApiError ? e.message : "Failed to send media")
      }
    },
    [session, ingest, recompute, markSendFailed],
  )

  const sendMedia = useCallback(
    async (files: File[], caption: string, opts?: SendOpts) => {
      if (files.length === 0) return
      await doSendMedia(randomId(), files, caption, opts)
    },
    [doSendMedia],
  )

  // Retry a previously-failed optimistic message in place (same id, so it keeps
  // its position and won't duplicate if the original eventually lands). Handles
  // both media (re-encrypt + re-upload the original files) and text.
  const retrySend = useCallback(
    async (id: string) => {
      const media = pendingMediaById.current.get(id)
      if (media) {
        await doSendMedia(id, media.files, media.caption, media.opts)
        return
      }
      const p = pendingById.current.get(id)
      if (!p || p.kind !== "text" || !p.text) return
      pendingById.current.set(id, { ...p, failed: false, pending: true })
      void recompute()
      try {
        const ttlMs = p.expiresAt ? Math.max(1000, p.expiresAt - Date.now()) : undefined
        const envelope = await encodeText(session, id, p.text, p.replyTo)
        const res = await api.postMessage({
          roomId: session.invite.roomId,
          accessProof: session.keys.accessProof,
          participantProof: session.participantProof,
          message: {
            id,
            participantId: session.participantId,
            envelope,
            kind: "text",
            ttlMs,
            burn: p.burn,
          },
        })
        ingest(res.message)
      } catch (e) {
        const cur = pendingById.current.get(id)
        if (cur) pendingById.current.set(id, { ...cur, pending: false, failed: true })
        void recompute()
        setError(e instanceof ApiError ? e.message : "Failed to send")
      }
    },
    [session, ingest, recompute, doSendMedia],
  )

  // Edit one of my own already-sent messages. Re-encrypts (and re-signs) the new
  // text into a fresh envelope, optimistically swaps it locally, then asks the
  // server to relay the edit to everyone. Preserves any reply reference.
  const editMessage = useCallback(
    async (id: string, newText: string) => {
      const trimmed = newText.trim()
      if (!trimmed) return
      const stored = storedById.current.get(id)
      if (!stored || stored.participantId !== session.participantId) return
      if (stored.kind !== "text" && stored.kind !== "media") return
      const cached = decodeCache.current.get(id)?.out
      const replyTo = cached?.replyTo
      try {
        const editedAt = Date.now()
        const envelope =
          stored.kind === "media"
            ? await encodeMedia(session, id, trimmed, cached?.items ?? [], replyTo)
            : await encodeText(session, id, trimmed, replyTo)
        storedById.current.set(id, { ...stored, envelope, editedAt })
        decodeCache.current.delete(id)
        void recompute()
        const res = await api.editMessage({
          roomId: session.invite.roomId,
          accessProof: session.keys.accessProof,
          participantProof: session.participantProof,
          messageId: id,
          participantId: session.participantId,
          envelope,
          kind: stored.kind,
        })
        ingest(res.message)
      } catch (e) {
        setError(e instanceof ApiError ? e.message : "Failed to edit message")
      }
    },
    [session, ingest, recompute],
  )

  // Delete one of my own messages for everyone. A still-pending optimistic
  // message is just dropped locally; an acked one becomes a tombstone both
  // locally and on the server (which also frees any backing media bytes).
  const deleteMessage = useCallback(
    async (id: string) => {
      if (pendingById.current.has(id) && !storedById.current.has(id)) {
        pendingById.current.delete(id)
        pendingMediaById.current.delete(id)
        void recompute()
        return
      }
      const stored = storedById.current.get(id)
      if (!stored || stored.participantId !== session.participantId) return
      const tomb: StoredMessage = {
        ...stored,
        envelope: "",
        media: undefined,
        reactions: undefined,
        deletedAt: Date.now(),
      }
      storedById.current.set(id, tomb)
      decodeCache.current.delete(id)
      void recompute()
      try {
        const res = await api.deleteOwnMessage({
          roomId: session.invite.roomId,
          accessProof: session.keys.accessProof,
          participantProof: session.participantProof,
          messageId: id,
          participantId: session.participantId,
        })
        ingest(res.message)
      } catch (e) {
        setError(e instanceof ApiError ? e.message : "Failed to delete message")
      }
    },
    [session, ingest, recompute],
  )

  // Broadcast how far we've read so peers can show per-person read receipts.
  // Throttled via lastSeenSent; sent over the live socket (silently dropped on
  // the polling fallback, which is acceptable for ephemeral receipts).
  const markSeen = useCallback(
    (lastSeen: number) => {
      if (!lastSeen || lastSeen <= lastSeenSent.current) return
      lastSeenSent.current = lastSeen
      rt.current?.sendSignal({ t: "seen", participantId: session.participantId, lastSeen })
    },
    [session.participantId],
  )

  const toggleReaction = useCallback(
    async (messageId: string, emoji: string) => {
      const stored = storedById.current.get(messageId)
      const rid = await makeReactionId(session, emoji)
      const already = stored?.reactions?.[rid]
      try {
        const envelope = already ? null : await encodeReaction(session, emoji)
        await api.react({
          roomId: session.invite.roomId,
          accessProof: session.keys.accessProof,
          participantProof: session.participantProof,
          messageId,
          reactionId: rid,
          participantId: session.participantId,
          envelope,
        })
        if (stored) {
          const reactions = { ...(stored.reactions || {}) }
          if (envelope === null) delete reactions[rid]
          else reactions[rid] = { participantId: session.participantId, envelope }
          storedById.current.set(messageId, { ...stored, reactions })
          void recompute()
        }
      } catch (e) {
        setError(e instanceof ApiError ? e.message : "Failed to react")
      }
    },
    [session, recompute],
  )

  const prune = useCallback(
    async (ids: string[]) => {
      if (ids.length === 0) return
      try {
        const res = await api.prune({
          roomId: session.invite.roomId,
          accessProof: session.keys.accessProof,
          ...participantAuth(session),
          messageIds: ids,
        })
        for (const id of res.removedIds) storedById.current.delete(id)
        void recompute()
      } catch (e) {
        setError(e instanceof ApiError ? e.message : "Failed to prune")
      }
    },
    [session, recompute],
  )

  const pruneAll = useCallback(async () => {
    if (!session.ownerSecret) {
      setError("Only the room owner can clear the whole room")
      return
    }
    try {
      const res = await api.prune({
        roomId: session.invite.roomId,
        accessProof: session.keys.accessProof,
        ownerProof: session.ownerSecret,
        all: true,
      })
      for (const id of res.removedIds) storedById.current.delete(id)
      void recompute()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to prune")
    }
  }, [session, recompute])

  const wipeLocal = useCallback(() => {
    storedById.current.clear()
    pendingById.current.clear()
    pendingMediaById.current.clear()
    decodeCache.current.clear()
    noticesRef.current = []
    rt.current?.stop()
    vault.forget(session.invite.roomId)
    setMessages([])
  }, [session.invite.roomId])

  const deleteRoom = useCallback(async () => {
    if (!session.ownerSecret) {
      setError("Only the room owner can delete the room")
      return
    }
    try {
      await api.deleteRoom(session.invite.roomId, session.keys.accessProof, session.ownerSecret)
      vault.forget(session.invite.roomId)
      setDeleted(true)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to delete room")
    }
  }, [session])

  // Owner-only: set (or clear with "") the encrypted room topic. The plaintext
  // never leaves the device unencrypted; the server stores only the opaque
  // envelope and rebroadcasts the new room state to everyone.
  const updateTopic = useCallback(
    async (newTopic: string) => {
      if (!session.ownerSecret) return
      try {
        const trimmed = newTopic.trim().slice(0, 200)
        const topicEnvelope = trimmed ? await encodeTopic(session, trimmed) : null
        const res = await api.setTopic({
          roomId: session.invite.roomId,
          accessProof: session.keys.accessProof,
          ownerProof: session.ownerSecret,
          topicEnvelope,
        })
        applyRoomState(res.room)
      } catch (e) {
        setError(e instanceof ApiError ? e.message : "Failed to update topic")
      }
    },
    [session, applyRoomState],
  )

  // Owner-only moderation. The server verifies the owner secret independently;
  // a non-owner calling this is rejected server-side.
  const ownerAction = useCallback(
    async (action: "ban" | "unban" | "clear" | "destroy", targetParticipantId?: string) => {
      if (!session.ownerSecret) return
      try {
        const res = await api.ownerAction({
          roomId: session.invite.roomId,
          accessProof: session.keys.accessProof,
          ownerProof: session.ownerSecret,
          action,
          targetParticipantId,
        })
        if (res.room) applyRoomState(res.room)
        if (res.removedIds && res.removedIds.length > 0) {
          for (const rid of res.removedIds) storedById.current.delete(rid)
          void recompute()
        }
      } catch (e) {
        setError(e instanceof ApiError ? e.message : "Owner action failed")
      }
    },
    [session, applyRoomState, recompute],
  )

  const banMember = useCallback(
    (participantId: string) => ownerAction("ban", participantId),
    [ownerAction],
  )
  const unbanMember = useCallback(
    (participantId: string) => ownerAction("unban", participantId),
    [ownerAction],
  )

  const notifyTyping = useCallback(() => {
    const now = Date.now()
    if (now - lastTypingSent.current < 1800) return
    lastTypingSent.current = now
    void encryptString(session.channelKey, session.username, aad(session, "channel"))
      .then((envelope) => {
        rt.current?.sendSignal({
          t: "signal",
          event: { type: "typing", participantId: session.participantId, envelope },
        })
      })
      .catch(() => {})
  }, [session])

  // Change my display name mid-session. Future messages carry the new name; a
  // live override updates my existing bubbles, and peers are notified so they
  // update my name on their side too.
  const rename = useCallback(
    (rawName: string) => {
      const name = rawName.trim().slice(0, 32) || "anon"
      session.username = name
      nameOverrides.current.set(session.participantId, name)
      const saved = vault.get(session.invite.roomId)
      if (saved) vault.save({ ...saved, username: name, lastUsed: Date.now() })
      void recompute()
      void encryptString(session.channelKey, name, aad(session, "channel"))
        .then((envelope) => {
          rt.current?.sendSignal({
            t: "signal",
            event: { type: "rename", participantId: session.participantId, envelope },
          })
        })
        .catch(() => {})
    },
    [session, recompute],
  )

  return useMemo(
    () => ({
      messages,
      connState,
      participantCount,
      room,
      topic,
      isOwner,
      bannedSelf,
      decoyEnabled,
      typing,
      othersSeenUpTo,
      seenBy,
      names,
      uploads,
      error,
      deleted,
      sendText,
      sendMedia,
      retrySend,
      editMessage,
      deleteMessage,
      markSeen,
      toggleReaction,
      prune,
      pruneAll,
      wipeLocal,
      deleteRoom,
      notifyTyping,
      rename,
      setTopic: updateTopic,
      banMember,
      unbanMember,
      toggleDecoy,
    }),
    [
      messages,
      connState,
      participantCount,
      room,
      topic,
      isOwner,
      bannedSelf,
      decoyEnabled,
      typing,
      othersSeenUpTo,
      seenBy,
      names,
      uploads,
      error,
      deleted,
      sendText,
      sendMedia,
      retrySend,
      editMessage,
      deleteMessage,
      markSeen,
      toggleReaction,
      prune,
      pruneAll,
      wipeLocal,
      deleteRoom,
      notifyTyping,
      rename,
      updateTopic,
      banMember,
      unbanMember,
      toggleDecoy,
    ],
  )
}
