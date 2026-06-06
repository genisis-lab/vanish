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
  encodeMedia,
  encodeText,
  reactionId as makeReactionId,
  encodeReaction,
  type DecryptedMessage,
  type ReplyRef,
} from "./messages"
import { encryptAndUpload, type MediaManifestItem, type UploadStatus } from "./media"
import { vault } from "./vault"

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
  typing: TypingUser[]
  othersSeenUpTo: number
  uploads: UploadState[]
  error: string | null
  deleted: boolean
  sendText: (text: string, opts?: SendOpts) => Promise<void>
  sendMedia: (files: File[], caption: string, opts?: SendOpts) => Promise<void>
  retrySend: (id: string) => Promise<void>
  toggleReaction: (messageId: string, emoji: string) => Promise<void>
  prune: (ids: string[]) => Promise<void>
  pruneAll: () => Promise<void>
  deleteRoom: () => Promise<void>
  notifyTyping: () => void
  rename: (name: string) => void
}

export function useRoom(session: RoomSession): RoomController {
  const [messages, setMessages] = useState<DecryptedMessage[]>([])
  const [connState, setConnState] = useState<ConnState>("connecting")
  const [participantCount, setParticipantCount] = useState(1)
  const [room, setRoom] = useState<PublicRoomState | null>(null)
  const [typing, setTyping] = useState<TypingUser[]>([])
  const [othersSeenUpTo, setOthersSeenUpTo] = useState(0)
  const [uploads, setUploads] = useState<UploadState[]>([])
  const [error, setError] = useState<string | null>(null)
  const [deleted, setDeleted] = useState(false)

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
    // Single ordered pass: apply live nickname overrides and trust-on-first-use
    // signing-key pinning. Both produce new objects so cached decode results are
    // never mutated. Iterating in chronological order means the earliest key we
    // see for a participant becomes the pinned one; a later mismatch is flagged.
    const final = merged.map((m) => {
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

  // Apply a fresh participant count and surface join/leave notices on change.
  const applyPresence = useCallback(
    (count: number) => {
      setParticipantCount(count)
      const prev = prevCountRef.current
      prevCountRef.current = count
      if (prev === null || count === prev) return
      if (count > prev) {
        const n = count - prev
        pushNotice(n === 1 ? "Someone joined the room" : n + " people joined")
      } else {
        const n = prev - count
        pushNotice(n === 1 ? "Someone left the room" : n + " people left")
      }
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

  useEffect(() => {
    let cancelled = false
    async function boot() {
      try {
        await api.session({
          roomId: session.invite.roomId,
          accessProof: session.keys.accessProof,
          participantId: session.participantId,
        })
        const res = await api.listMessages({
          roomId: session.invite.roomId,
          accessProof: session.keys.accessProof,
          markReadFor: session.participantId,
        })
        if (cancelled) return
        for (const m of res.messages) storedById.current.set(m.id, m)
        setRoom(res.room)
        applyPresence(res.room.participantCount)
        await recompute()
      } catch (e) {
        if (!cancelled) setError(e instanceof ApiError ? e.message : "Failed to load room")
      }
    }
    void boot()

    const realtime = new Realtime(session, {
      onMessage: (m) => {
        markPeerActive(m.participantId)
        ingest(m)
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
        }
      },
      onRoomDeleted: () => setDeleted(true),
      onState: setConnState,
      getSince: () => sinceRef.current,
    })
    rt.current = realtime
    realtime.start()

    // Keep our presence fresh so the participant count (and join/leave notices)
    // stay accurate even when we are on the polling fallback. The server only
    // refreshes presence on /session, not /list.
    const heartbeat = setInterval(() => {
      void api
        .session({
          roomId: session.invite.roomId,
          accessProof: session.keys.accessProof,
          participantId: session.participantId,
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
      if (p) pending