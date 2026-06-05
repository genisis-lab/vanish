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
  sendText: (text: string) => Promise<void>
  sendMedia: (files: File[], caption: string) => Promise<void>
  toggleReaction: (messageId: string, emoji: string) => Promise<void>
  prune: (ids: string[]) => Promise<void>
  pruneAll: () => Promise<void>
  deleteRoom: () => Promise<void>
  notifyTyping: () => void
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
  const rt = useRef<Realtime | null>(null)
  const sinceRef = useRef(0)
  const lastTypingSent = useRef(0)

  const recompute = useCallback(async () => {
    const all = Array.from(storedById.current.values()).sort((a, b) => a.createdAt - b.createdAt)
    const decoded = await Promise.all(all.map((m) => decodeMessage(session, m)))
    setMessages(decoded)
    sinceRef.current = all.reduce((mx, m) => Math.max(mx, m.createdAt), sinceRef.current)
  }, [session])

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
        })
        if (cancelled) return
        for (const m of res.messages) storedById.current.set(m.id, m)
        setRoom(res.room)
        setParticipantCount(res.room.participantCount)
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
      onPresence: (count) => setParticipantCount(count),
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
        }
      },
      onRoomDeleted: () => setDeleted(true),
      onState: setConnState,
      getSince: () => sinceRef.current,
    })
    rt.current = realtime
    realtime.start()

    const typingGc = setInterval(() => {
      setTyping((prev) => prev.filter((t) => Date.now() - t.at < 4000))
    }, 1500)

    return () => {
      cancelled = true
      clearInterval(typingGc)
      realtime.stop()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session])

  const sendText = useCallback(
    async (text: string) => {
      const trimmed = text.trim()
      if (!trimmed) return
      const id = randomId()
      const optimistic: DecryptedMessage = {
        id,
        participantId: session.participantId,
        kind: "text",
        createdAt: Date.now(),
        expiresAt: null,
        mine: true,
        username: session.username,
        text: trimmed,
        reactions: [],
        pending: true,
      }
      setMessages((prev) => [...prev, optimistic])
      try {
        const envelope = await encodeText(session, trimmed)
        const res = await api.postMessage({
          roomId: session.invite.roomId,
          accessProof: session.keys.accessProof,
          message: { id, participantId: session.participantId, envelope, kind: "text" },
        })
        ingest(res.message)
      } catch (e) {
        setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, pending: false, failed: true } : m)))
        setError(e instanceof ApiError ? e.message : "Failed to send")
      }
    },
    [session, ingest],
  )

  const sendMedia = useCallback(
    async (files: File[], caption: string) => {
      if (files.length === 0) return
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
          setError(e instanceof ApiError ? e.message : "Upload failed")
          return
        } finally {
          setTimeout(
            () => setUploads((prev) => prev.filter((u) => u.id !== uploadId)),
            1500,
          )
        }
      }
      try {
        const id = randomId()
        const envelope = await encodeMedia(session, caption.trim(), items)
        const res = await api.postMessage({
          roomId: session.invite.roomId,
          accessProof: session.keys.accessProof,
          message: { id, participantId: session.participantId, envelope, kind: "media", media: refs },
        })
        ingest(res.message)
      } catch (e) {
        setError(e instanceof ApiError ? e.message : "Failed to send media")
      }
    },
    [session, ingest],
  )

  const toggleReaction = useCallback(
    async (messageId: string, emoji: string) => {
      const stored = storedById.current.get(messageId)
      const rid = makeReactionId(session, emoji)
      const already = stored?.reactions?.[rid]
      try {
        const envelope = already ? null : await encodeReaction(session, emoji)
        await api.react({
          roomId: session.invite.roomId,
          accessProof: session.keys.accessProof,
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
      for (const id of ids) storedById.current.delete(id)
      void recompute()
      try {
        await api.prune({
          roomId: session.invite.roomId,
          accessProof: session.keys.accessProof,
          messageIds: ids,
        })
      } catch (e) {
        setError(e instanceof ApiError ? e.message : "Failed to prune")
      }
    },
    [session, recompute],
  )

  const pruneAll = useCallback(async () => {
    storedById.current.clear()
    void recompute()
    try {
      await api.prune({ roomId: session.invite.roomId, accessProof: session.keys.accessProof, all: true })
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to prune")
    }
  }, [session, recompute])

  const deleteRoom = useCallback(async () => {
    try {
      await api.deleteRoom(session.invite.roomId, session.keys.accessProof)
      vault.forget(session.invite.roomId)
      setDeleted(true)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to delete room")
    }
  }, [session])

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

  return useMemo(
    () => ({
      messages,
      connState,
      participantCount,
      room,
      typing,
      othersSeenUpTo,
      uploads,
      error,
      deleted,
      sendText,
      sendMedia,
      toggleReaction,
      prune,
      pruneAll,
      deleteRoom,
      notifyTyping,
    }),
    [
      messages,
      connState,
      participantCount,
      room,
      typing,
      othersSeenUpTo,
      uploads,
      error,
      deleted,
      sendText,
      sendMedia,
      toggleReaction,
      prune,
      pruneAll,
      deleteRoom,
      notifyTyping,
    ],
  )
}
