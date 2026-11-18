// Orchestrates a joined room: presence registration, history load, realtime
// transport, optimistic sends, reactions, typing, pruning and deletion. All
// encryption/decryption happens here or in the helpers it calls.
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { decryptString, encryptString } from "@shared/crypto"
import type { AbuseReportCategory, PublicRoomState, StoredMessage } from "@shared/types"
import { isNeverExpireTtl, messageExpiresAt, shorterTtl } from "@shared/constants"
import { api, ApiError, isBannedError } from "./api"
import { Realtime, RESUME_RECONNECT_MS, type ConnState } from "./realtime"
import { MessageStore } from "./messageStore"
import { aad, type RoomSession } from "./session"
import { randomId } from "./clientCrypto"
import {
  decodeMessage,
  decodePin,
  decodeTopic,
  encodeDecoy,
  encodeMedia,
  encodePin,
  encodeReaction,
  encodeSystem,
  encodeText,
  encodeTopic,
  reactionId as makeReactionId,
  timerNoticeText,
  type DecryptedMessage,
  type PinnedRef,
  type ReplyRef,
} from "./messages"
import { mentionsName, plainText } from "./richText"
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
  messageId: string
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
  /** Decrypted pinned message reference, or null. */
  pinned: PinnedRef | null
  /** True when this device holds the owner secret for the room. */
  isOwner: boolean
  /** True once the owner has removed (banned) this participant. */
  bannedSelf: boolean
  /** Whether cover-traffic (decoy messages) is currently being emitted. */
  decoyEnabled: boolean
  typing: TypingUser[]
  readByMessage: Record<string, string[]>
  /** participantId -> best-known display name, for rendering read receipts. */
  names: Record<string, string>
  uploads: UploadState[]
  error: string | null
  deleted: boolean
  sendText: (text: string, opts?: SendOpts) => Promise<void>
  sendMedia: (files: File[], caption: string, opts?: SendOpts) => Promise<void>
  cancelUpload: (messageId: string) => void
  retrySend: (id: string) => Promise<void>
  /** Resolves true once the server has the edit. */
  editMessage: (id: string, text: string) => Promise<boolean>
  /** Resolves true once the message is deleted for everyone. */
  deleteMessage: (id: string) => Promise<boolean>
  reportMessage: (id: string, category: AbuseReportCategory) => Promise<void>
  markSeen: (messageIds: string[]) => void
  toggleReaction: (messageId: string, emoji: string) => Promise<void>
  prune: (ids: string[]) => Promise<void>
  /** Owner-only: remove every message for everyone. Resolves true on success. */
  pruneAll: () => Promise<boolean>
  wipeLocal: () => void
  deleteRoom: () => Promise<void>
  notifyTyping: () => void
  rename: (name: string) => void
  /** Owner-only: set (or clear, with "") the encrypted room topic. Resolves true on success. */
  setTopic: (topic: string) => Promise<boolean>
  /** Any member (owner only while locked): change the timer for everyone. */
  /** keepIds: with "never", also stop the countdown on these shown messages. */
  setMessageTimer: (ttlMs: number, opts?: { keepIds?: string[] }) => Promise<void>
  /** Owner-only: let only the owner change the timer (true) or anyone (false). */
  setTimerLocked: (locked: boolean) => Promise<boolean>
  /** Owner-only: pin a message for everyone, or clear the pin with null. Resolves true on success. */
  setPinned: (msg: DecryptedMessage | null) => Promise<boolean>
  /** Owner-only: ban a participant by id (server-enforced). */
  banMember: (participantId: string) => Promise<void>
  /** Owner-only: lift a ban. */
  unbanMember: (participantId: string) => Promise<void>
  /** Toggle cover-traffic emission on/off. */
  toggleDecoy: () => void
}

// Shown while the first load keeps failing; cleared once it succeeds.
const LOAD_ERROR = "Couldn\u2019t load messages. Retrying\u2026"
// Back on the tab after at least this long: check for anything missed.
const RESUME_SYNC_MS = 5_000

function participantAuth(session: RoomSession) {
  return {
    participantId: session.participantId,
    participantProof: session.participantProof,
  }
}

// Show the countdown on a just-sent message right away, using the timer the
// server will apply: the chat-wide one, or a shorter per-message one.
function optimisticExpiryFor(
  now: number,
  room: PublicRoomState | null,
  opts?: { ttlMs?: number; burn?: boolean },
): number | null {
  const roomTtl = room?.defaultTtlMs
  const ttl = opts?.ttlMs ?? roomTtl
  if (ttl === undefined) return null
  const burn = opts?.burn ?? room?.burnAfterRead ?? false
  return messageExpiresAt(now, roomTtl === undefined ? ttl : shorterTtl(ttl, roomTtl), burn)
}

export function useRoom(session: RoomSession): RoomController {
  const [messages, setMessages] = useState<DecryptedMessage[]>([])
  const [connState, setConnState] = useState<ConnState>("connecting")
  const [participantCount, setParticipantCount] = useState(1)
  const [room, setRoom] = useState<PublicRoomState | null>(null)
  // Latest room state for callbacks that shouldn't re-create on every update.
  const roomRef = useRef<PublicRoomState | null>(null)
  const [topic, setTopicState] = useState("")
  const [pinned, setPinnedState] = useState<PinnedRef | null>(null)
  const [bannedSelf, setBannedSelf] = useState(false)
  const [decoyEnabled, setDecoyEnabled] = useState(
    () => !!vault.get(session.invite.roomId)?.decoyEnabled,
  )
  const [typing, setTyping] = useState<TypingUser[]>([])
  const [names, setNames] = useState<Record<string, string>>({})
  const [uploads, setUploads] = useState<UploadState[]>([])
  const [error, setError] = useState<string | null>(null)
  const [deleted, setDeleted] = useState(false)

  // This device owns the room iff it holds the owner secret (set at creation or
  // imported via multi-device sync). The server independently verifies the
  // secret on every owner action, so this only governs which controls we show.
  const isOwner = !!session.ownerSecret

  // Encrypted messages as the server sent them. Merges out-of-order answers
  // (see messageStore.ts) so a stale sync can't undo or resurrect anything.
  const store = useRef(new MessageStore())
  // True once the first sync has loaded the history (no alerts for that one).
  const loadedRef = useRef(false)
  // An error from opening the room, cleared once the history loads after all.
  const bootErrorRef = useRef<string | null>(null)
  // Cache of already-decrypted messages keyed by id. Avoids re-running AES-GCM
  // over the entire history on every send/receive (the old hot path that made
  // sending feel slow as the room grew). A cache entry is reused only while the
  // underlying stored object is unchanged (reactions create a new object).
  const decodeCache = useRef(new Map<string, { src: StoredMessage; out: DecryptedMessage }>())
  // Optimistic, not-yet-acknowledged outgoing messages. Removed once the server
  // echoes the same id back into the store.
  const pendingById = useRef(new Map<string, DecryptedMessage>())
  // Original File objects for in-flight/failed media sends, keyed by message id,
  // so a failed upload can be retried in place (same id, no duplicate).
  const pendingMediaById = useRef(
    new Map<string, { files: File[]; caption: string; opts?: SendOpts }>(),
  )
  // Client-only system notices (join/leave). Never sent to or stored on server.
  const noticesRef = useRef<DecryptedMessage[]>([])
  const joinEnvelopes = useRef(new Set<string>())
  // Live display-name overrides keyed by participantId, applied on top of the
  // names baked into past envelopes so a mid-session rename shows consistently.
  const nameOverrides = useRef(new Map<string, string>())
  // First-seen Ed25519 signing key per participant (trust-on-first-use). Used to
  // flag a sender whose signing key later changes mid-session.
  const signerKeys = useRef(new Map<string, string>())
  const prevCountRef = useRef<number | null>(null)
  // Latest participantId -> name map, readable from realtime callbacks.
  const namesRef = useRef<Record<string, string>>({})
  const rt = useRef<Realtime | null>(null)
  const lastTypingSent = useRef(0)
  const uploadControllers = useRef(new Map<string, AbortController>())
  const cancelUpload = useCallback((id: string) => uploadControllers.current.get(id)?.abort(), [])
  useEffect(
    () => () => {
      uploadControllers.current.forEach((c) => c.abort())
      uploadControllers.current.clear()
    },
    [],
  )
  const readSent = useRef(new Set<string>())
  const readInFlight = useRef(new Set<string>())
  const [readByMessage, setReadByMessage] = useState<Record<string, string[]>>({})

  const recompute = useCallback(async () => {
    const all = Array.from(store.current.values()).sort((a, b) => a.createdAt - b.createdAt)
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
      if (store.current.has(id)) pendingById.current.delete(id)
    }
    for (const id of Array.from(pendingMediaById.current.keys())) {
      if (store.current.has(id)) pendingMediaById.current.delete(id)
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
        // Timer notices name their author; keep that in step with renames too.
        if (
          o &&
          !m.mine &&
          m.system?.event === "timer" &&
          typeof m.system.ttlMs === "number" &&
          m.username !== o
        )
          out = {
            ...out,
            username: o,
            text: timerNoticeText(o, m.system.ttlMs, m.system.keptExisting === true),
          }
        if (m.kind !== "system" && m.verified === "ok" && m.signerKey) {
          const pinned = signerKeys.current.get(m.participantId)
          if (!pinned) signerKeys.current.set(m.participantId, m.signerKey)
          else if (pinned !== m.signerKey)
            out = out === m ? { ...m, keyChanged: true } : { ...out, keyChanged: true }
        }
        return out
      })
    setMessages(final)
    // Build a best-known name map (from baked-in usernames, with live overrides
    // winning) so per-person read receipts can show real names.
    const nameMap: Record<string, string> = {}
    for (const m of final) {
      if (m.kind !== "system" && m.username && m.username !== "anon")
        nameMap[m.participantId] = m.username
    }
    for (const [pid, nm] of nameOverrides.current) nameMap[pid] = nm
    namesRef.current = nameMap
    setNames(nameMap)
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
      roomRef.current = r
      setRoom(r)
      if (r.topicEnvelope) {
        void decodeTopic(session, r.topicEnvelope)
          .then((t) => setTopicState(t))
          .catch(() => setTopicState(""))
      } else {
        setTopicState("")
      }
      if (r.pinEnvelope) {
        void decodePin(session, r.pinEnvelope).then((p) => setPinnedState(p))
      } else {
        setPinnedState(null)
      }
    },
    [session],
  )

  // Apply a fresh participant count. Joins are announced by name via the
  // "join" signal (see onSignal), so we only surface a generic notice when
  // someone leaves — leavers can't be named from a bare count.
  const applyPresence = useCallback(
    (count: number, left?: string[]) => {
      setParticipantCount(count)
      const prev = prevCountRef.current
      prevCountRef.current = count
      // The server names who dropped out when it can; use the best-known name.
      const named = (left ?? []).filter((pid) => pid !== session.participantId)
      for (const pid of named) {
        const name = nameOverrides.current.get(pid) || namesRef.current[pid]
        pushNotice(name ? `${name} left the room` : "Someone left the room")
      }
      // Without names (polling, or right after the server woke up) fall back to
      // a generic notice from the count drop.
      if (named.length > 0 || prev === null || count >= prev) return
      const n = prev - count
      pushNotice(n === 1 ? "Someone left the room" : n + " people left")
    },
    [pushNotice, session.participantId],
  )

  // The server's reply to one of our own writes. It never moves the sync
  // cursor (that lives in Realtime): a message someone else sent just before
  // ours must still be fetched by the next sync.
  const ingest = useCallback(
    (stored: StoredMessage) => {
      store.current.accept(stored)
      // Drop the optimistic copy even if the store ignored the reply (the
      // message may already be gone, e.g. opened once or pruned).
      pendingById.current.delete(stored.id)
      void recompute()
    },
    [recompute],
  )

  // In-place envelope swap, reaction change or tombstone from a peer (or our
  // own echo). Recompute without notifying or reordering.
  const applyUpdate = useCallback(
    (m: StoredMessage) => {
      if (store.current.accept(m)) void recompute()
    },
    [recompute],
  )

  // Clear the countdown on messages the chat chose to keep. The decrypted copy
  // is patched in place so hundreds of kept messages don't all re-decrypt.
  const applyKept = useCallback(
    (ids: string[]) => {
      let changed = false
      for (const id of ids) {
        const stored = store.current.get(id)
        if (!stored || stored.expiresAt === null) continue
        const next = { ...stored, expiresAt: null }
        store.current.patch(next)
        const cached = decodeCache.current.get(id)
        if (cached && cached.src === stored) {
          decodeCache.current.set(id, { src: next, out: { ...cached.out, expiresAt: null } })
        }
        changed = true
      }
      if (changed) void recompute()
    },
    [recompute],
  )

  // Surface a local OS/PWA notification for an incoming message from someone
  // else while the tab is hidden. The message is decrypted on-device and only
  // the already-visible sender name + a short preview are shown; nothing extra
  // leaves the browser. Gated on the user's pref + granted OS permission, and
  // suppressed entirely for rooms the user muted on this device.
  const maybeNotify = useCallback(
    (m: StoredMessage) => {
      if (m.participantId === session.participantId || m.kind === "system" || m.burn) return
      if (typeof document !== "undefined" && document.visibilityState === "visible") return
      if (!notificationsEnabled()) return
      const saved = vault.get(session.invite.roomId)
      if (saved?.muted) return
      void decodeMessage(session, m)
        .then((d) => {
          if (d.decoy) return
          if (saved?.mentionsOnly && !mentionsName(d.text, session.username)) return
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
    let announced = false
    let announcing = false
    let joinEnvelope: string | undefined
    async function announceJoin() {
      if (cancelled || announced || announcing) return
      announcing = true
      try {
        joinEnvelope ??= await encryptString(session.channelKey, session.username, aad(session, "channel"))
        if (cancelled) return
        await api.broadcast({
          roomId: session.invite.roomId,
          accessProof: session.keys.accessProof,
          ...participantAuth(session),
          event: { type: "join", participantId: session.participantId, envelope: joinEnvelope },
        })
        announced = true
      } catch {
        // Retry on the next successful presence heartbeat, using the same
        // envelope so recipients can deduplicate an ambiguous response.
      } finally {
        announcing = false
      }
    }
    const realtime = new Realtime(session, {
      onMessage: (m) => {
        const result = store.current.accept(m)
        if (!result) return
        if (result === "added") maybeNotify(m)
        void recompute()
      },
      onEdit: (m) => applyUpdate(m),
      onPrune: (ids, all) => {
        if (all) store.current.removeAll()
        // Remember each id, held or not, so an older sync can't bring it back.
        for (const id of ids) store.current.remove(id)
        void recompute()
      },
      onSync: ({ messages, currentMessageIds, serverTime }) => {
        const firstLoad = !loadedRef.current
        let changed = firstLoad
        for (const m of messages) {
          const result = store.current.accept(m)
          if (!result) continue
          changed = true
          // No alerts for the history that loads when the room opens.
          if (result === "added" && !firstLoad) maybeNotify(m)
        }
        let missingFrom: number | null = null
        if (currentMessageIds) {
          const reconciled = store.current.reconcile(currentMessageIds, serverTime)
          if (reconciled.removedIds.length) changed = true
          missingFrom = reconciled.missingFrom
        }
        if (firstLoad) {
          loadedRef.current = true
          const bootError = bootErrorRef.current
          setError((e) => (e === LOAD_ERROR || (e !== null && e === bootError) ? null : e))
        }
        if (changed) void recompute()
        return missingFrom
      },
      onSyncError: (e) => {
        if (isBannedError(e)) {
          setBannedSelf(true)
          rt.current?.stop()
        } else if (!loadedRef.current) {
          setError(LOAD_ERROR)
        }
      },
      onReact: (f) => {
        const stored = store.current.get(f.messageId)
        if (!stored) return
        const reactions = { ...(stored.reactions || {}) }
        if (f.envelope === null) delete reactions[f.reactionId]
        else reactions[f.reactionId] = { participantId: f.participantId, envelope: f.envelope }
        store.current.patch({ ...stored, reactions })
        void recompute()
      },
      onPresence: (count, left) => applyPresence(count, left),
      onSignal: (f) => {
        const ev = f.event

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
          const envelope = ev.envelope
          void decryptString(session.channelKey, ev.envelope, aad(session, "channel"))
            .then((raw) => {
              if (cancelled || joinEnvelopes.current.has(envelope)) return
              joinEnvelopes.current.add(envelope)
              if (joinEnvelopes.current.size > 200) {
                joinEnvelopes.current.delete(joinEnvelopes.current.values().next().value!)
              }
              const name = raw.trim().slice(0, 32) || "anon"
              nameOverrides.current.set(ev.participantId, name)
              pushNotice(`${name} joined the room`)
              void recompute()
            })
            .catch(() => {})
        }
      },
      onSeen: (participantId, _lastSeen, messageIds) => {
        if (participantId === session.participantId || !messageIds?.length) return
        setReadByMessage((prev) => {
          const next = { ...prev }
          for (const id of messageIds) {
            if (store.current.has(id))
              next[id] = [...new Set([...(prev[id] ?? []), participantId])]
          }
          return next
        })
      },
      onRoomUpdated: (r) => applyRoomState(r),
      onKept: (ids) => applyKept(ids),
      onBanned: (participantId) => {
        if (participantId === session.participantId) {
          // The owner removed us: tear down realtime and surface a clear notice.
          setBannedSelf(true)
          rt.current?.stop()
        } else {
          const name = nameOverrides.current.get(participantId) || namesRef.current[participantId]
          nameOverrides.current.delete(participantId)
          pushNotice(
            name
              ? `${name} was removed by the room owner`
              : "A participant was removed by the room owner",
          )
        }
      },
      onRoomDeleted: () => setDeleted(true),
      onState: setConnState,
    })
    rt.current = realtime

    // Register this device in the room first: the socket and the list both
    // check the participant proof, so a first visit would otherwise be refused.
    async function boot() {
      try {
        await api.session({
          roomId: session.invite.roomId,
          accessProof: session.keys.accessProof,
          ...participantAuth(session),
        })
        if (cancelled) return
        void announceJoin()
      } catch (e) {
        if (cancelled) return
        if (isBannedError(e)) {
          setBannedSelf(true)
          return
        }
        // Start anyway: polling and the heartbeat recover once the network does.
        const message = e instanceof ApiError ? e.message : "Failed to load room"
        bootErrorRef.current = message
        setError(message)
      }
      realtime.start()
    }
    void boot()

    // Arm a gesture-backed permission prompt so message notifications can be
    // enabled (browsers only prompt from a user gesture). No-op once decided.
    ensureNotificationPrompt()

    // If notifications are already enabled on this device, (re)register a Web
    // Push subscription so messages can wake the app even when it's fully closed.
    if (notificationsEnabled()) void subscribePush(session)

    // Coming back to the tab or the network: catch up on anything missed, and
    // replace a socket that may have died while the app was in the background.
    let hiddenAt: number | null = null
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        hiddenAt = Date.now()
        return
      }
      const away = hiddenAt === null ? 0 : Date.now() - hiddenAt
      hiddenAt = null
      if (away >= RESUME_SYNC_MS) realtime.resume(away)
    }
    const onOnline = () => realtime.resume(RESUME_RECONNECT_MS)
    document.addEventListener("visibilitychange", onVisibility)
    window.addEventListener("online", onOnline)

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
        .then(() => announceJoin())
        .catch(() => {})
    }, 20000)

    const typingGc = setInterval(() => {
      setTyping((prev) => prev.filter((t) => Date.now() - t.at < 4000))
    }, 1500)

    return () => {
      cancelled = true
      clearInterval(heartbeat)
      clearInterval(typingGc)
      document.removeEventListener("visibilitychange", onVisibility)
      window.removeEventListener("online", onOnline)
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
      setError(null)
      const now = Date.now()
      const optimistic: DecryptedMessage = {
        id,
        participantId: session.participantId,
        kind: "text",
        createdAt: now,
        expiresAt: optimisticExpiryFor(now, roomRef.current, opts),
        sendTtlMs: opts?.ttlMs,
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
      if (uploadControllers.current.has(id)) return
      const controller = new AbortController()
      uploadControllers.current.set(id, controller)
      try {
        setError(null)
        const now = Date.now()
        const optimistic: DecryptedMessage = {
          id,
          participantId: session.participantId,
          kind: "media",
          createdAt: now,
          expiresAt: optimisticExpiryFor(now, roomRef.current, opts),
          sendTtlMs: opts?.ttlMs,
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
            { id: uploadId, messageId: id, filename: file.name, status: "encrypting", progress: 0 },
          ])
          try {
            controller.signal.throwIfAborted()
            const { ref, manifest } = await encryptAndUpload(
              session,
              file,
              (status, progress) =>
                setUploads((prev) =>
                  prev.map((u) =>
                    u.id === uploadId ? { ...u, status, progress: progress ?? u.progress } : u,
                  ),
                ),
              controller.signal,
            )
            items.push(manifest)
            refs.push(ref)
          } catch (e) {
            markSendFailed(id)
            setError(
              controller.signal.aborted
                ? "Upload cancelled. You can retry the message to send it again."
                : e instanceof Error
                  ? e.message
                  : "Upload failed",
            )
            return
          } finally {
            setTimeout(() => setUploads((prev) => prev.filter((u) => u.id !== uploadId)), 1500)
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
          controller.signal.throwIfAborted()
          const envelope = await encodeMedia(session, id, caption.trim(), items, opts?.replyTo)
          controller.signal.throwIfAborted()
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
          setError(
            controller.signal.aborted
              ? "Upload cancelled."
              : e instanceof ApiError
                ? e.message
                : "Failed to send media",
          )
        }
      } finally {
        uploadControllers.current.delete(id)
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
        // A retry follows the chat's current timer (the server applies it
        // when ttlMs is omitted) unless the send asked for its own.
        const ttlMs = p.sendTtlMs
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
    async (id: string, newText: string): Promise<boolean> => {
      const trimmed = newText.trim()
      if (!trimmed) return false
      const stored = store.current.get(id)
      if (!stored || stored.participantId !== session.participantId) return false
      if (stored.kind !== "text" && stored.kind !== "media") return false
      const cached = decodeCache.current.get(id)?.out
      // A caption edit re-sends the attachment list; without it, the edit would drop them.
      if (stored.kind === "media" && !cached?.items?.length) return false
      const replyTo = cached?.replyTo
      let optimistic: StoredMessage | null = null
      try {
        const editedAt = Date.now()
        const envelope =
          stored.kind === "media"
            ? await encodeMedia(session, id, trimmed, cached?.items ?? [], replyTo)
            : await encodeText(session, id, trimmed, replyTo)
        optimistic = { ...stored, envelope, editedAt }
        store.current.patch(optimistic)
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
        return true
      } catch (e) {
        // Show the text everyone else still sees, not an edit that never landed.
        if (optimistic && store.current.get(id) === optimistic) {
          store.current.restore(stored)
          void recompute()
        }
        setError(e instanceof ApiError ? e.message : "Failed to edit message")
        return false
      }
    },
    [session, ingest, recompute],
  )

  // Delete one of my own messages for everyone. A still-pending optimistic
  // message is just dropped locally; an acked one becomes a tombstone both
  // locally and on the server (which also frees any backing media bytes).
  const deleteMessage = useCallback(
    async (id: string): Promise<boolean> => {
      if (pendingById.current.has(id) && !store.current.has(id)) {
        pendingById.current.delete(id)
        pendingMediaById.current.delete(id)
        void recompute()
        return true
      }
      const stored = store.current.get(id)
      if (!stored || stored.participantId !== session.participantId) return false
      const tomb: StoredMessage = {
        ...stored,
        envelope: "",
        media: undefined,
        reactions: undefined,
        deletedAt: Date.now(),
      }
      store.current.patch(tomb)
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
        return true
      } catch (e) {
        // Still there for everyone else, so bring it back here too.
        if (store.current.get(id) === tomb) {
          store.current.restore(stored)
          void recompute()
        }
        setError(e instanceof ApiError ? e.message : "Failed to delete message")
        return false
      }
    },
    [session, ingest, recompute],
  )

  // Acknowledge only message IDs actually visible to this reader.
  const markSeen = useCallback(
    (ids: string[]) => {
      const messageIds = ids
        .filter((id) => !readSent.current.has(id) && !readInFlight.current.has(id))
        .slice(0, 100)
      if (!messageIds.length) return
      messageIds.forEach((id) => readInFlight.current.add(id))
      void api
        .readMessages({
          roomId: session.invite.roomId,
          accessProof: session.keys.accessProof,
          ...participantAuth(session),
          messageIds,
        })
        .then(() => {
          messageIds.forEach((id) => readSent.current.add(id))
        })
        .catch(() => {
          /* The viewport observer retries while these messages remain visible. */
        })
        .finally(() => messageIds.forEach((id) => readInFlight.current.delete(id)))
    },
    [session],
  )

  const toggleReaction = useCallback(
    async (messageId: string, emoji: string) => {
      const rid = await makeReactionId(session, emoji)
      const already = store.current.get(messageId)?.reactions?.[rid]
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
        // Re-read: an edit or another reaction may have landed meanwhile.
        const stored = store.current.get(messageId)
        if (stored && !stored.deletedAt) {
          const reactions = { ...(stored.reactions || {}) }
          if (envelope === null) delete reactions[rid]
          else reactions[rid] = { participantId: session.participantId, envelope }
          store.current.patch({ ...stored, reactions })
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
        for (const id of res.removedIds) store.current.remove(id)
        void recompute()
      } catch (e) {
        setError(e instanceof ApiError ? e.message : "Failed to prune")
      }
    },
    [session, recompute],
  )

  const pruneAll = useCallback(async (): Promise<boolean> => {
    if (!session.ownerSecret) {
      setError("Only the room owner can clear the whole room")
      return false
    }
    try {
      const res = await api.prune({
        roomId: session.invite.roomId,
        accessProof: session.keys.accessProof,
        ownerProof: session.ownerSecret,
        all: true,
      })
      for (const id of res.removedIds) store.current.remove(id)
      void recompute()
      return true
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to clear the chat")
      return false
    }
  }, [session, recompute])

  const wipeLocal = useCallback(() => {
    store.current.clear()
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
    async (newTopic: string): Promise<boolean> => {
      if (!session.ownerSecret) return false
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
        return true
      } catch (e) {
        setError(e instanceof ApiError ? e.message : "Failed to update topic")
        return false
      }
    },
    [session, applyRoomState],
  )

  // Any member can change the chat-wide disappearing timer. The server applies
  // it, rebroadcasts the room state to everyone, and stores the encrypted
  // notice as a system message so the change shows in the conversation.
  const setMessageTimer = useCallback(
    async (ttlMs: number, opts?: { keepIds?: string[] }) => {
      try {
        const id = randomId()
        const keepIds = isNeverExpireTtl(ttlMs) ? (opts?.keepIds ?? []) : []
        const keepExisting = keepIds.length > 0
        const envelope = await encodeSystem(session, {
          event: "timer",
          username: session.username,
          text: "",
          ttlMs,
          ...(keepExisting ? { keptExisting: true } : {}),
        })
        const res = await api.setTimer({
          roomId: session.invite.roomId,
          accessProof: session.keys.accessProof,
          ...participantAuth(session),
          ttlMs,
          ownerProof: session.ownerSecret,
          notice: { id, envelope },
          ...(keepExisting ? { keepIds } : {}),
        })
        applyRoomState(res.room)
        if (res.keptIds?.length) applyKept(res.keptIds)
        if (res.message) ingest(res.message)
      } catch (e) {
        setError(e instanceof ApiError ? e.message : "Failed to change the timer")
      }
    },
    [session, applyRoomState, applyKept, ingest],
  )

  const setTimerLocked = useCallback(
    async (locked: boolean): Promise<boolean> => {
      if (!session.ownerSecret) return false
      try {
        const res = await api.updateInvite({
          roomId: session.invite.roomId,
          accessProof: session.keys.accessProof,
          ownerProof: session.ownerSecret,
          lockTimer: locked,
        })
        applyRoomState(res.room)
        return true
      } catch (e) {
        setError(e instanceof ApiError ? e.message : "Failed to update the timer setting")
        return false
      }
    },
    [session, applyRoomState],
  )

  // Owner-only: the pin (message id + short preview) is encrypted here; the
  // server stores the opaque envelope and rebroadcasts the room state.
  const setPinned = useCallback(
    async (msg: DecryptedMessage | null): Promise<boolean> => {
      if (!session.ownerSecret) return false
      try {
        const preview =
          msg?.text && !msg.text.startsWith("\u26a0")
            ? plainText(msg.text).slice(0, 140)
            : msg?.items?.length
              ? "\u{1F4CE} Attachment"
              : "Message"
        const pinEnvelope = msg
          ? await encodePin(session, { id: msg.id, username: msg.username, preview })
          : null
        const res = await api.setPin({
          roomId: session.invite.roomId,
          accessProof: session.keys.accessProof,
          ownerProof: session.ownerSecret,
          pinEnvelope,
        })
        applyRoomState(res.room)
        return true
      } catch (e) {
        setError(e instanceof ApiError ? e.message : "Failed to update the pinned message")
        return false
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
          for (const rid of res.removedIds) store.current.remove(rid)
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
  const reportMessage = useCallback(
    async (messageId: string, category: AbuseReportCategory) => {
      await api.reportMessage({
        roomId: session.invite.roomId,
        accessProof: session.keys.accessProof,
        ...participantAuth(session),
        messageId,
        category,
      })
    },
    [session],
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
      readByMessage,
      names,
      uploads,
      error,
      deleted,
      sendText,
      sendMedia,
      retrySend,
      cancelUpload,
      editMessage,
      deleteMessage,
      reportMessage,
      markSeen,
      toggleReaction,
      prune,
      pruneAll,
      wipeLocal,
      deleteRoom,
      notifyTyping,
      rename,
      setTopic: updateTopic,
      setMessageTimer,
      setTimerLocked,
      setPinned,
      pinned,
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
      readByMessage,
      names,
      uploads,
      error,
      deleted,
      sendText,
      sendMedia,
      retrySend,
      cancelUpload,
      editMessage,
      deleteMessage,
      reportMessage,
      markSeen,
      toggleReaction,
      prune,
      pruneAll,
      wipeLocal,
      deleteRoom,
      notifyTyping,
      rename,
      updateTopic,
      setMessageTimer,
      setTimerLocked,
      setPinned,
      pinned,
      banMember,
      unbanMember,
      toggleDecoy,
    ],
  )
}
