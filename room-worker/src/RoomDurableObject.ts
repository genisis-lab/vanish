// RoomDurableObject — one instance per room id.
//
// Responsibilities:
//   - persist room metadata + encrypted message envelopes (never plaintext)
//   - verify the access proof (proof-of-possession of the invite secret)
//   - coordinate realtime delivery over WebSockets
//   - sweep expired messages via storage alarms and delete orphaned R2 objects
//   - self-destruct the whole room when its lifetime elapses
//   - enforce basic abuse controls (rate limit, envelope size cap, room cap)
//   - enforce owner controls (encrypted topic, bans, clear, destroy)
//   - fan out background Web Push pings to closed/asleep devices
//
// All chat content is opaque to this object. It only ever sees ciphertext and
// operational metadata (ids, timestamps, sizes, verifier hashes).

import { RoomCore, type RoomSnapshot } from "../../shared/roomCore"
import { hashAccessProof } from "../../shared/crypto"
import type {
  BroadcastRequest,
  CreateRoomRequest,
  DeleteOwnMessageRequest,
  EditMessageRequest,
  EncryptedMediaRef,
  ListMessagesRequest,
  OwnerActionRequest,
  PostMessageRequest,
  PruneRequest,
  PushSubscribeRequest,
  PushUnsubscribeRequest,
  ReactRequest,
  RealtimeFrame,
  SessionRequest,
  SetTopicRequest,
  StoredMessage,
  UpdateInviteRequest,
  ValidateInviteRequest,
} from "../../shared/types"
import {
  clampRoomLifetime,
  inviteExpiryToMs,
  isValidObjectKey,
  isValidRoomId,
  MAX_ENVELOPE_CHARS,
  MAX_ID_CHARS,
  MAX_MEDIA_BYTES,
  MAX_MESSAGES_PER_ROOM,
  MAX_PUSH_SUBSCRIPTIONS,
  MESSAGE_RATE_LIMIT,
  MESSAGE_RATE_WINDOW_MS,
} from "../../shared/constants"
import { sendWebPush, type PushSubscription, type VapidKeys } from "./webpush"

export interface RoomEnv {
  MEDIA: R2Bucket
  /** VAPID keys for Web Push. When unset, push fan-out is silently disabled. */
  VAPID_PUBLIC_KEY?: string
  VAPID_PRIVATE_KEY?: string
  VAPID_SUBJECT?: string
}

interface Session {
  ws: WebSocket
  participantId: string
}

// A stored Web Push registration. The endpoint + keys are opaque routing data
// for the push service; participantId lets us skip pushing to someone who is
// already connected over a live socket or has a fresh visible-room heartbeat.
interface PushRecord {
  sub: PushSubscription
  participantId: string
  at: number
}

const SNAPSHOT_KEY = "snapshot"
const PUSH_KEY = "pushSubs"
const PUSH_FOREGROUND_SUPPRESS_MS = 30_000
// Signalling frames (typing/seen) are cheap, so they get a more generous rate
// limit than message sends — but they are still bounded to stop floods.
const SIGNAL_RATE_LIMIT = MESSAGE_RATE_LIMIT * 4
// Hard cap on a relayed WebSocket frame. Signal frames are tiny; anything
// larger is dropped without parsing.
const MAX_WS_FRAME_CHARS = 16_384
// Push endpoints are URLs we POST to; keep them sane.
const MAX_PUSH_ENDPOINT_CHARS = 2048
const MAX_PUSH_KEY_CHARS = 512
// A message may reference at most this many media objects.
const MAX_MEDIA_REFS = 10

export class RoomDurableObject {
  private state: DurableObjectState
  private env: RoomEnv
  private core: RoomCore
  private sessions = new Set<Session>()
  // Short-lived signalling frames (typing/seen) buffered so clients on the
  // polling fallback can receive them via the list response. In-memory only.
  private recentSignals: Array<{ at: number; frame: RealtimeFrame }> = []
  // Per-participant send timestamps for rate limiting. In-memory only.
  private rate = new Map<string, number[]>()
  // Lazily-loaded Web Push registrations, keyed by endpoint. Persisted so they
  // survive hibernation; null until first read.
  private pushSubs: Map<string, PushRecord> | null = null
  private loaded = false

  constructor(state: DurableObjectState, env: RoomEnv) {
    this.state = state
    this.env = env
    this.core = new RoomCore()
    this.state.blockConcurrencyWhile(async () => {
      const snap = await this.state.storage.get<RoomSnapshot>(SNAPSHOT_KEY)
      if (snap) this.core = new RoomCore(snap)
      this.loaded = true
    })
  }

  private async persist(): Promise<void> {
    await this.state.storage.put(SNAPSHOT_KEY, this.core.toSnapshot())
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) await this.state.blockConcurrencyWhile(async () => {})
  }

  // ---------- routing ----------

  async fetch(request: Request): Promise<Response> {
    await this.ensureLoaded()
    // Enforce room self-destruct before handling any op, so an expired room
    // behaves as deleted even if the alarm has not fired yet.
    if (await this.enforceLifetime(Date.now())) {
      const url = new URL(request.url)
      if (url.pathname.replace(/^\//, "") === "ws") {
        return new Response("gone", { status: 410 })
      }
    }
    const url = new URL(request.url)
    const op = url.pathname.replace(/^\//, "")

    if (op === "ws") return this.handleWebSocket(request, url)

    let body: Record<string, unknown> = {}
    if (request.method !== "GET") {
      try {
        body = await request.json()
      } catch {
        body = {}
      }
    }

    try {
      switch (op) {
        case "create":
          return this.opCreate(body as unknown as CreateRoomRequest)
        case "validate":
          return this.opValidate(body as unknown as ValidateInviteRequest)
        case "session":
          return this.opSession(body as unknown as SessionRequest)
        case "update":
          return this.opUpdate(body as unknown as UpdateInviteRequest)
        case "set-topic":
          return this.opSetTopic(body as unknown as SetTopicRequest)
        case "owner-action":
          return this.opOwnerAction(body as unknown as OwnerActionRequest)
        case "message":
          return this.opMessage(body as unknown as PostMessageRequest)
        case "edit":
          return this.opEdit(body as unknown as EditMessageRequest)
        case "delete-message":
          return this.opDeleteOwn(body as unknown as DeleteOwnMessageRequest)
        case "list":
          return this.opList(body as unknown as ListMessagesRequest)
        case "prune":
          return this.opPrune(body as unknown as PruneRequest)
        case "react":
          return this.opReact(body as unknown as ReactRequest)
        case "broadcast":
          return this.opBroadcast(body as unknown as BroadcastRequest)
        case "push-subscribe":
          return this.opPushSubscribe(body as unknown as PushSubscribeRequest)
        case "push-unsubscribe":
          return this.opPushUnsubscribe(body as unknown as PushUnsubscribeRequest)
        case "delete":
          return this.opDelete(body as { accessProof: string; ownerProof?: string })
        default:
          return json({ error: "unknown op" }, 404)
      }
    } catch (err) {
      return json({ error: (err as Error).message || "internal error" }, 500)
    }
  }

  // ---------- proof gates ----------

  private async verifyProof(accessProof: string | undefined): Promise<boolean> {
    if (!accessProof || typeof accessProof !== "string") return false
    const hash = await hashAccessProof(accessProof)
    return this.core.verifyHash(hash)
  }

  // Owner proof-of-possession: the raw owner secret hashes to the stored owner
  // verifier. Distinct from the access proof so only the creator can moderate.
  private async verifyOwnerProof(ownerProof: string | undefined): Promise<boolean> {
    if (!ownerProof || typeof ownerProof !== "string") return false
    const hash = await hashAccessProof(ownerProof)
    return this.core.verifyOwner(hash)
  }

  private async hashPresentedProof(proof: string | undefined): Promise<string | null> {
    if (!proof || typeof proof !== "string" || proof.length > 200) return null
    try {
      return await hashAccessProof(proof)
    } catch {
      return null
    }
  }

  private async registerParticipantProof(req: {
    participantId?: string
    participantProof?: string
  }): Promise<boolean> {
    if (!this.validId(req.participantId)) return false
    const proofHash = await this.hashPresentedProof(req.participantProof)
    if (!proofHash) return false
    return this.core.registerParticipant(req.participantId, Date.now(), proofHash)
  }

  private async verifyParticipantProof(req: {
    participantId?: string
    participantProof?: string
  }): Promise<boolean> {
    if (!this.validId(req.participantId)) return false
    const proofHash = await this.hashPresentedProof(req.participantProof)
    if (!proofHash) return false
    return this.core.verifyParticipant(req.participantId, proofHash)
  }

  // Sliding-window per-participant rate limiter. Best-effort; in-memory only.
  private allowRate(id: string, now: number, limit = MESSAGE_RATE_LIMIT): boolean {
    const arr = (this.rate.get(id) ?? []).filter((t) => now - t < MESSAGE_RATE_WINDOW_MS)
    if (arr.length >= limit) {
      this.rate.set(id, arr)
      return false
    }
    arr.push(now)
    this.rate.set(id, arr)
    return true
  }

  // Generic guard for client-supplied identifier strings (message ids,
  // participant ids). Bounded so ids can't be used to bloat storage.
  private validId(id: unknown): id is string {
    return typeof id === "string" && id.length > 0 && id.length <= MAX_ID_CHARS
  }

  // Media refs must point inside THIS room's R2 prefix and match the exact key
  // pattern minted by /api/uploads/sign. Without this check a sender could
  // attach another room's object keys to a message and have our expiry sweeps
  // delete that other room's media (cross-room deletion).
  private validMediaRefs(media: EncryptedMediaRef[] | undefined, roomId: string): boolean {
    if (media === undefined || media === null) return true
    if (!Array.isArray(media) || media.length > MAX_MEDIA_REFS) return false
    for (const ref of media) {
      if (!ref || typeof ref.objectKey !== "string") return false
      if (!isValidObjectKey(ref.objectKey)) return false
      if (!ref.objectKey.startsWith(`rooms/${roomId}/`)) return false
      if (!Number.isInteger(ref.size) || ref.size <= 0 || ref.size > MAX_MEDIA_BYTES) {
        return false
      }
      if (!["image", "video", "audio"].includes(ref.previewKind)) return false
    }
    return true
  }

  // Push endpoints are URLs this object POSTs to, so they must be real https
  // URLs — this stops the worker being used as a generic request proxy (SSRF).
  private validPushEndpoint(endpoint: unknown): endpoint is string {
    if (typeof endpoint !== "string" || !endpoint || endpoint.length > MAX_PUSH_ENDPOINT_CHARS) {
      return false
    }
    try {
      return new URL(endpoint).protocol === "https:"
    } catch {
      return false
    }
  }

  // ---------- operations ----------

  private async opCreate(req: CreateRoomRequest): Promise<Response> {
    const now = Date.now()
    if (!req.roomId || !req.accessProofHash) return json({ error: "missing fields" }, 400)
    // Room ids become R2 key prefixes and DO names; reject anything that could
    // collide with another room's prefix (e.g. ids containing "/").
    if (!isValidRoomId(req.roomId)) return json({ error: "bad room id" }, 400)
    if (typeof req.accessProofHash !== "string" || req.accessProofHash.length > 200) {
      return json({ error: "bad verifier" }, 400)
    }
    if (
      req.ownerKeyHash != null &&
      (typeof req.ownerKeyHash !== "string" || req.ownerKeyHash.length > 200)
    ) {
      return json({ error: "bad verifier" }, 400)
    }
    if (req.topicEnvelope && req.topicEnvelope.length > MAX_ENVELOPE_CHARS) {
      return json({ error: "too large" }, 413)
    }
    this.core.createRoom({
      roomId: req.roomId,
      accessProofHash: req.accessProofHash,
      inviteExpiresAt: inviteExpiryToMs(req.inviteExpiry ?? "never", now),
      ttlMs: req.ttlMs,
      burnAfterRead: req.burnAfterRead,
      roomLifetimeMs: req.roomLifetimeMs,
      ownerKeyHash: req.ownerKeyHash ?? null,
      topicEnvelope: req.topicEnvelope ?? null,
      now,
    })
    await this.persist()
    // A room with a lifetime needs an alarm even if no message is ever sent.
    await this.scheduleSweep()
    return json({ room: this.core.publicState(now) })
  }

  private async opValidate(req: ValidateInviteRequest): Promise<Response> {
    const now = Date.now()
    const status = this.core.validateInvite(req.accessProofHash ?? "", now)
    return json({ status, room: status === "valid" ? this.core.publicState(now) : undefined })
  }

  private async opSession(req: SessionRequest): Promise<Response> {
    if (!(await this.verifyProof(req.accessProof))) return json({ error: "forbidden" }, 403)
    if (!this.validId(req.participantId)) return json({ error: "bad participant" }, 400)
    if (this.core.isBanned(req.participantId)) return json({ error: "banned" }, 403)
    const now = Date.now()
    if (this.core.isInviteExpired(now)) return json({ error: "expired" }, 410)
    if (!(await this.registerParticipantProof(req))) {
      return json({ error: "bad participant proof" }, 403)
    }
    await this.persist()
    this.broadcast({ t: "presence", participantCount: this.core.participantCount(now) })
    return json({ room: this.core.publicState(now) })
  }

  private async opUpdate(req: UpdateInviteRequest): Promise<Response> {
    if (!(await this.verifyProof(req.accessProof))) return json({ error: "forbidden" }, 403)
    if (!(await this.verifyOwnerProof(req.ownerProof))) return json({ error: "not owner" }, 403)
    const now = Date.now()
    let destroyAt: number | null | undefined
    if (req.roomLifetimeMs !== undefined) {
      const lifetime = clampRoomLifetime(req.roomLifetimeMs)
      destroyAt = lifetime > 0 ? now + lifetime : null
    }
    const room = this.core.updateRoom({
      inviteExpiresAt:
        req.inviteExpiry !== undefined ? inviteExpiryToMs(req.inviteExpiry, now) : undefined,
      ttlMs: req.ttlMs,
      burnAfterRead: req.burnAfterRead,
      destroyAt,
    })
    if (!room) return json({ error: "not found" }, 404)
    await this.persist()
    await this.scheduleSweep()
    return json({ room: this.core.publicState(now) })
  }

  // Owner-gated: set or clear the opaque encrypted room topic, then notify peers.
  private async opSetTopic(req: SetTopicRequest): Promise<Response> {
    if (!(await this.verifyProof(req.accessProof))) return json({ error: "forbidden" }, 403)
    if (!(await this.verifyOwnerProof(req.ownerProof))) return json({ error: "not owner" }, 403)
    const now = Date.now()
    const envelope = req.topicEnvelope ?? null
    if (envelope && envelope.length > MAX_ENVELOPE_CHARS) return json({ error: "too large" }, 413)
    const room = this.core.setTopic(envelope)
    if (!room) return json({ error: "not found" }, 404)
    await this.persist()
    const state = this.core.publicState(now)
    if (state) this.broadcast({ t: "room-updated", room: state })
    return json({ room: state })
  }

  // Owner-gated moderation: ban/unban a participant, clear all messages, or
  // destroy the whole room.
  private async opOwnerAction(req: OwnerActionRequest): Promise<Response> {
    if (!(await this.verifyProof(req.accessProof))) return json({ error: "forbidden" }, 403)
    if (!(await this.verifyOwnerProof(req.ownerProof))) return json({ error: "not owner" }, 403)
    const now = Date.now()
    switch (req.action) {
      case "ban": {
        if (!req.targetParticipantId) return json({ error: "missing target" }, 400)
        this.core.banParticipant(req.targetParticipantId)
        await this.persist()
        // Notify the banned device, then drop its live sockets.
        this.broadcast({ t: "banned", participantId: req.targetParticipantId })
        for (const s of this.sessions) {
          if (s.participantId === req.targetParticipantId) {
            try {
              s.ws.close(1008, "banned")
            } catch {
              /* ignore */
            }
            this.sessions.delete(s)
          }
        }
        this.broadcast({ t: "presence", participantCount: this.core.participantCount(now) })
        const state = this.core.publicState(now)
        if (state) this.broadcast({ t: "room-updated", room: state })
        return json({ room: state })
      }
      case "unban": {
        if (!req.targetParticipantId) return json({ error: "missing target" }, 400)
        this.core.unbanParticipant(req.targetParticipantId)
        await this.persist()
        const state = this.core.publicState(now)
        if (state) this.broadcast({ t: "room-updated", room: state })
        return json({ room: state })
      }
      case "clear": {
        const result = this.core.pruneAll()
        await this.persist()
        if (result.orphanObjectKeys.length) await this.deleteObjects(result.orphanObjectKeys)
        this.broadcast({ t: "prune", messageIds: result.removedIds, all: true })
        return json({ removedIds: result.removedIds })
      }
      case "destroy": {
        await this.destroyRoom(now)
        return json({ ok: true })
      }
      default:
        return json({ error: "unknown action" }, 400)
    }
  }

  private async opMessage(req: PostMessageRequest): Promise<Response> {
    if (!(await this.verifyProof(req.accessProof))) return json({ error: "forbidden" }, 403)
    if (!req.message) return json({ error: "bad message" }, 400)
    if (!this.validId(req.message.id) || !this.validId(req.message.participantId)) {
      return json({ error: "bad message" }, 400)
    }
    if (
      !(await this.verifyParticipantProof({
        participantId: req.message.participantId,
        participantProof: req.participantProof,
      }))
    ) {
      return json({ error: "bad participant proof" }, 403)
    }
    if (this.core.isBanned(req.message.participantId)) return json({ error: "banned" }, 403)
    const now = Date.now()
    if (this.core.isInviteExpired(now) && req.message.kind !== "system") {
      // Expired invites block new joins/sends but existing data is preserved.
      return json({ error: "expired" }, 410)
    }
    // Abuse controls: validate shapes, cap envelope size, rate-limit per sender.
    if (typeof req.message.envelope !== "string") return json({ error: "bad message" }, 400)
    if (req.message.envelope.length > MAX_ENVELOPE_CHARS) {
      return json({ error: "message too large" }, 413)
    }
    if (typeof req.message.kind !== "string" || req.message.kind.length > 32) {
      return json({ error: "bad message" }, 400)
    }
    const room = this.core.getRoom()
    if (!room) return json({ error: "not found" }, 404)
    if (!this.validMediaRefs(req.message.media, room.roomId)) {
      return json({ error: "bad media ref" }, 400)
    }
    if (!this.allowRate(req.message.participantId, now)) {
      return json({ error: "rate limited" }, 429)
    }
    const message = this.core.addMessage(
      {
        id: req.message.id,
        participantId: req.message.participantId,
        senderSlot: req.message.senderSlot,
        envelope: req.message.envelope,
        media: req.message.media,
        kind: req.message.kind,
        ttlMs: req.message.ttlMs,
        burn: req.message.burn,
      },
      now,
    )
    // Deliver to connected peers immediately, before the storage round-trips
    // (persist + alarm scheduling), so realtime delivery feels instant.
    // Durability follows right after; a crash in the gap at worst drops a
    // single just-sent message, which the sender can resend.
    this.broadcast({ t: "message", message })
    // Wake background/closed devices via Web Push. Fire-and-forget so it never
    // blocks the send; only real content triggers it.
    if (req.message.kind !== "system") void this.sendPushNotifications(message)
    // Rolling per-room cap: prune the oldest messages beyond the ceiling.
    const all = this.core.list(now)
    if (all.length > MAX_MESSAGES_PER_ROOM) {
      const overflow = all.slice(0, all.length - MAX_MESSAGES_PER_ROOM).map((m) => m.id)
      const pr = this.core.prune(overflow)
      if (pr.orphanObjectKeys.length) await this.deleteObjects(pr.orphanObjectKeys)
      if (pr.removedIds.length) this.broadcast({ t: "prune", messageIds: pr.removedIds })
    }
    await this.persist()
    await this.scheduleSweep()
    return json({ message })
  }

  // Replace the caller's own message envelope (edit-your-own). The plaintext is
  // re-encrypted + re-signed client-side; we only swap one opaque envelope for
  // another. Broadcast a dedicated "edit" frame so peers update in place without
  // re-notifying or re-ordering.
  private async opEdit(req: EditMessageRequest): Promise<Response> {
    if (!(await this.verifyProof(req.accessProof))) return json({ error: "forbidden" }, 403)
    if (!this.validId(req.participantId)) return json({ error: "bad participant" }, 400)
    if (!(await this.verifyParticipantProof(req))) {
      return json({ error: "bad participant proof" }, 403)
    }
    if (this.core.isBanned(req.participantId)) return json({ error: "banned" }, 403)
    const now = Date.now()
    if (typeof req.envelope !== "string" || !req.envelope) return json({ error: "bad envelope" }, 400)
    if (req.envelope.length > MAX_ENVELOPE_CHARS) {
      return json({ error: "message too large" }, 413)
    }
    if (!this.allowRate(req.participantId, now)) {
      return json({ error: "rate limited" }, 429)
    }
    const message = this.core.editMessage(
      { messageId: req.messageId, participantId: req.participantId, envelope: req.envelope },
      now,
    )
    if (!message) return json({ error: "not found" }, 404)
    this.broadcast({ t: "edit", message })
    await this.persist()
    return json({ message })
  }

  // Soft-delete the caller's own message, leaving a tombstone and freeing any
  // backing R2 bytes. Broadcast as an "edit" frame (same in-place update path).
  private async opDeleteOwn(req: DeleteOwnMessageRequest): Promise<Response> {
    if (!(await this.verifyProof(req.accessProof))) return json({ error: "forbidden" }, 403)
    if (!this.validId(req.participantId)) return json({ error: "bad participant" }, 400)
    if (!(await this.verifyParticipantProof(req))) {
      return json({ error: "bad participant proof" }, 403)
    }
    if (this.core.isBanned(req.participantId)) return json({ error: "banned" }, 403)
    const now = Date.now()
    const result = this.core.deleteOwnMessage(
      { messageId: req.messageId, participantId: req.participantId },
      now,
    )
    if (!result) return json({ error: "not found" }, 404)
    await this.persist()
    if (result.orphanObjectKeys.length) await this.deleteObjects(result.orphanObjectKeys)
    this.broadcast({ t: "edit", message: result.message })
    return json({ message: result.message })
  }

  private async opList(req: ListMessagesRequest): Promise<Response> {
    if (!(await this.verifyProof(req.accessProof))) return json({ error: "forbidden" }, 403)
    if (!this.validId(req.participantId)) return json({ error: "bad participant" }, 400)
    if (req.markReadFor && req.markReadFor !== req.participantId) {
      return json({ error: "bad reader" }, 400)
    }
    if (!(await this.verifyParticipantProof(req))) {
      return json({ error: "bad participant proof" }, 403)
    }
    // Banned participants keep the access proof but lose room capabilities.
    if (this.core.isBanned(req.participantId)) {
      return json({ error: "banned" }, 403)
    }
    const now = Date.now()
    const swept = this.core.sweep(now)
    if (swept.orphanObjectKeys.length) await this.deleteObjects(swept.orphanObjectKeys)
    let messages = this.core.list(now)
    if (typeof req.since === "number") messages = messages.filter((m) => m.createdAt > req.since!)

    // burn-after-read: mark read for this reader (removes others' burn msgs)
    if (req.markReadFor) {
      const { burnedIds, orphanObjectKeys } = this.core.markRead(req.markReadFor, now)
      if (burnedIds.length) {
        await this.persist()
        if (orphanObjectKeys.length) await this.deleteObjects(orphanObjectKeys)
        this.broadcast({ t: "prune", messageIds: burnedIds })
      }
    }
    const signalsSince = typeof req.signalsSince === "number" ? req.signalsSince : now
    const signals = this.recentSignals.filter((s) => s.at > signalsSince).map((s) => s.frame)
    return json({ messages, room: this.core.publicState(now), serverTime: now, signals })
  }

  private async opPrune(req: PruneRequest): Promise<Response> {
    if (!(await this.verifyProof(req.accessProof))) return json({ error: "forbidden" }, 403)
    let result: { removedIds: string[]; orphanObjectKeys: string[] }
    if (req.all) {
      if (!(await this.verifyOwnerProof(req.ownerProof))) return json({ error: "not owner" }, 403)
      result = this.core.pruneAll()
    } else if (req.ownerProof && (await this.verifyOwnerProof(req.ownerProof))) {
      result = this.core.prune(req.messageIds ?? [])
    } else {
      if (!this.validId(req.participantId)) return json({ error: "bad participant" }, 400)
      if (!(await this.verifyParticipantProof(req))) {
        return json({ error: "bad participant proof" }, 403)
      }
      if (this.core.isBanned(req.participantId)) return json({ error: "banned" }, 403)
      result = this.core.pruneOwn(req.messageIds ?? [], req.participantId)
    }
    await this.persist()
    if (result.orphanObjectKeys.length) await this.deleteObjects(result.orphanObjectKeys)
    this.broadcast({ t: "prune", messageIds: result.removedIds, all: req.all })
    return json({ removedIds: result.removedIds })
  }

  private async opReact(req: ReactRequest): Promise<Response> {
    if (!(await this.verifyProof(req.accessProof))) return json({ error: "forbidden" }, 403)
    if (!this.validId(req.participantId)) return json({ error: "bad participant" }, 400)
    if (!this.validId(req.reactionId)) return json({ error: "bad reaction" }, 400)
    if (!(await this.verifyParticipantProof(req))) {
      return json({ error: "bad participant proof" }, 403)
    }
    if (this.core.isBanned(req.participantId)) return json({ error: "banned" }, 403)
    if (req.envelope != null) {
      if (typeof req.envelope !== "string" || req.envelope.length > MAX_ENVELOPE_CHARS) {
        return json({ error: "bad envelope" }, 400)
      }
    }
    if (!this.allowRate(req.participantId, Date.now())) {
      return json({ error: "rate limited" }, 429)
    }
    const m = this.core.setReaction({
      messageId: req.messageId,
      reactionId: req.reactionId,
      participantId: req.participantId,
      envelope: req.envelope,
    })
    if (!m) return json({ error: "not found" }, 404)
    // Broadcast first for snappy delivery; persist the updated state after.
    this.broadcast({
      t: "react",
      messageId: req.messageId,
      reactionId: req.reactionId,
      participantId: req.participantId,
      envelope: req.envelope,
    })
    await this.persist()
    return json({ ok: true })
  }

  private async opBroadcast(req: BroadcastRequest): Promise<Response> {
    if (!(await this.verifyProof(req.accessProof))) return json({ error: "forbidden" }, 403)
    if (!this.validId(req.participantId)) return json({ error: "bad participant" }, 400)
    if (!(await this.verifyParticipantProof(req))) {
      return json({ error: "bad participant proof" }, 403)
    }
    if (!req.event) {
      return json({ error: "bad event" }, 400)
    }
    if (this.core.isBanned(req.participantId)) return json({ error: "banned" }, 403)
    if (typeof req.event.type !== "string" || req.event.type.length > 64) {
      return json({ error: "bad event" }, 400)
    }
    if (req.event.envelope != null) {
      if (typeof req.event.envelope !== "string" || req.event.envelope.length > MAX_ENVELOPE_CHARS) {
        return json({ error: "bad event" }, 400)
      }
    }
    if (!this.allowRate(`sig:${req.participantId}`, Date.now(), SIGNAL_RATE_LIMIT)) {
      return json({ error: "rate limited" }, 429)
    }
    const frame: RealtimeFrame = {
      t: "signal",
      event: { ...req.event, participantId: req.participantId },
    }
    this.broadcast(frame)
    this.recordSignal(frame)
    return json({ ok: true })
  }

  private async opDelete(req: { accessProof: string; ownerProof?: string }): Promise<Response> {
    if (!(await this.verifyProof(req.accessProof))) return json({ error: "forbidden" }, 403)
    if (!(await this.verifyOwnerProof(req.ownerProof))) return json({ error: "not owner" }, 403)
    const now = Date.now()
    await this.destroyRoom(now)
    return json({ ok: true })
  }

  // ---------- web push ----------

  private async getPushSubs(): Promise<Map<string, PushRecord>> {
    if (this.pushSubs) return this.pushSubs
    const obj = (await this.state.storage.get<Record<string, PushRecord>>(PUSH_KEY)) ?? {}
    this.pushSubs = new Map(Object.entries(obj))
    return this.pushSubs
  }

  private async savePushSubs(): Promise<void> {
    if (!this.pushSubs) return
    await this.state.storage.put(PUSH_KEY, Object.fromEntries(this.pushSubs))
  }

  private vapid(): VapidKeys | null {
    const publicKey = this.env.VAPID_PUBLIC_KEY
    const privateKey = this.env.VAPID_PRIVATE_KEY
    if (!publicKey || !privateKey) return null
    return { publicKey, privateKey, subject: this.env.VAPID_SUBJECT || "mailto:admin@vanish.app" }
  }

  private async opPushSubscribe(req: PushSubscribeRequest): Promise<Response> {
    if (!(await this.verifyProof(req.accessProof))) return json({ error: "forbidden" }, 403)
    if (!this.validId(req.participantId)) return json({ error: "bad participant" }, 400)
    if (!(await this.verifyParticipantProof(req))) {
      return json({ error: "bad participant proof" }, 403)
    }
    if (this.core.isBanned(req.participantId)) return json({ error: "banned" }, 403)
    const s = req.subscription
    if (!s?.endpoint || !s?.keys?.p256dh || !s?.keys?.auth) {
      return json({ error: "bad subscription" }, 400)
    }
    if (!this.validPushEndpoint(s.endpoint)) return json({ error: "bad subscription" }, 400)
    if (typeof s.keys.p256dh !== "string" || s.keys.p256dh.length > MAX_PUSH_KEY_CHARS) {
      return json({ error: "bad subscription" }, 400)
    }
    if (typeof s.keys.auth !== "string" || s.keys.auth.length > MAX_PUSH_KEY_CHARS) {
      return json({ error: "bad subscription" }, 400)
    }
    const subs = await this.getPushSubs()
    // Cap stored registrations per room so push state can't grow unbounded;
    // evict the oldest registration when full.
    if (!subs.has(s.endpoint) && subs.size >= MAX_PUSH_SUBSCRIPTIONS) {
      let oldestKey: string | null = null
      let oldestAt = Infinity
      for (const [key, rec] of subs) {
        if (rec.at < oldestAt) {
          oldestAt = rec.at
          oldestKey = key
        }
      }
      if (oldestKey) subs.delete(oldestKey)
    }
    subs.set(s.endpoint, { sub: s, participantId: req.participantId, at: Date.now() })
    await this.savePushSubs()
    return json({ ok: true })
  }

  private async opPushUnsubscribe(req: PushUnsubscribeRequest): Promise<Response> {
    if (!(await this.verifyProof(req.accessProof))) return json({ error: "forbidden" }, 403)
    if (!this.validId(req.participantId)) return json({ error: "bad participant" }, 400)
    if (!(await this.verifyParticipantProof(req))) {
      return json({ error: "bad participant proof" }, 403)
    }
    const subs = await this.getPushSubs()
    const rec = req.endpoint ? subs.get(req.endpoint) : null
    if (rec?.participantId === req.participantId && subs.delete(req.endpoint)) await this.savePushSubs()
    return json({ ok: true })
  }

  // Best-effort background fan-out. Skips the sender, anyone currently
  // connected over a live socket (they already got the realtime frame), and
  // anyone with a fresh room heartbeat (mobile/polling fallback while visible).
  // Payloads carry no message content — the server can't read it anyway.
  private async sendPushNotifications(message: StoredMessage): Promise<void> {
    const vapid = this.vapid()
    if (!vapid) return
    const subs = await this.getPushSubs()
    if (subs.size === 0) return
    const now = Date.now()
    const connected = new Set<string>()
    for (const s of this.sessions) connected.add(s.participantId)
    const room = this.core.getRoom()
    const payload = JSON.stringify({ t: "msg", room: room?.roomId })
    const dead: string[] = []
    await Promise.all(
      Array.from(subs.values()).map(async (rec) => {
        if (rec.participantId === message.participantId) return
        if (connected.has(rec.participantId)) return
        const lastSeen = this.core.participantLastSeen(rec.participantId)
        if (typeof lastSeen === "number" && now - lastSeen <= PUSH_FOREGROUND_SUPPRESS_MS) return
        try {
          const status = await sendWebPush(rec.sub, payload, vapid)
          if (status === 404 || status === 410) dead.push(rec.sub.endpoint)
        } catch {
          /* best effort */
        }
      }),
    )
    if (dead.length) {
      for (const ep of dead) subs.delete(ep)
      await this.savePushSubs()
    }
  }

  // ---------- realtime ----------

  private async handleWebSocket(request: Request, url: URL): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 })
    }
    // Proofs arrive in the WebSocket subprotocol, not the query string, so they
    // stay out of CDN/proxy/access logs. Offered protocols, in order:
    //   "vanish.v1", <accessProof>, <participantId>, <participantProof>
    const offered = (request.headers.get("Sec-WebSocket-Protocol") ?? "")
      .split(",")
      .map((s) => s.trim())
    const dec = (s: string | undefined) => {
      try {
        return s ? decodeURIComponent(s) : ""
      } catch {
        return s ?? ""
      }
    }
    const usedSubprotocol = offered[0] === "vanish.v1"
    let accessProof: string
    let participantId: string
    let participantProof: string
    if (usedSubprotocol) {
      accessProof = dec(offered[1])
      participantId = dec(offered[2]) || "anon"
      participantProof = dec(offered[3])
    } else {
      // Back-compat during rollout: old clients still send query params.
      accessProof = url.searchParams.get("p") ?? ""
      participantId = url.searchParams.get("u") ?? "anon"
      participantProof = url.searchParams.get("pp") ?? ""
    }
    if (!(await this.verifyProof(accessProof))) {
      return new Response("forbidden", { status: 403 })
    }
    if (!this.validId(participantId)) return new Response("bad participant", { status: 400 })
    if (!(await this.verifyParticipantProof({ participantId, participantProof }))) {
      return new Response("bad participant proof", { status: 403 })
    }
    if (this.core.isBanned(participantId)) return new Response("banned", { status: 403 })
    const now = Date.now()
    if (this.core.isInviteExpired(now)) return new Response("expired", { status: 410 })

    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]
    server.accept()
    const session: Session = { ws: server, participantId }
    this.sessions.add(session)
    this.core.touchParticipant(participantId, now)

    server.addEventListener("message", (event: MessageEvent) => {
      this.onClientFrame(session, event.data)
    })
    const drop = () => {
      this.sessions.delete(session)
      this.broadcast({ t: "presence", participantCount: this.core.participantCount(Date.now()) })
    }
    server.addEventListener("close", drop)
    server.addEventListener("error", drop)

    this.send(session, { t: "hello", serverTime: now, participantCount: this.core.participantCount(now) })
    this.broadcast({ t: "presence", participantCount: this.core.participantCount(now) })

    // Echo the negotiated subprotocol so the browser completes the handshake.
    // Echo the NAME only, never the proof tokens.
    const wsHeaders = usedSubprotocol ? { "Sec-WebSocket-Protocol": "vanish.v1" } : undefined
    return new Response(null, { status: 101, webSocket: client, headers: wsHeaders })
  }

  // Client frames are opaque signalling (typing/presence/seen). Content stays
  // encrypted; we just relay envelopes between peers. Oversized or overly
  // frequent frames are dropped before they reach anyone.
  private onClientFrame(session: Session, raw: string | ArrayBuffer): void {
    const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw)
    if (text.length > MAX_WS_FRAME_CHARS) return
    let frame: RealtimeFrame | null = null
    try {
      frame = JSON.parse(text)
    } catch {
      return
    }
    if (!frame) return
    if (this.core.isBanned(session.participantId)) return
    const now = Date.now()
    this.core.touchParticipant(session.participantId, now)
    if (frame.t === "signal") {
      if (!frame.event || typeof frame.event.type !== "string") return
      if (!this.allowRate(`sig:${session.participantId}`, now, SIGNAL_RATE_LIMIT)) return
      const safeFrame: RealtimeFrame = {
        t: "signal",
        event: { ...frame.event, participantId: session.participantId },
      }
      this.broadcast(safeFrame, session)
      this.recordSignal(safeFrame)
    } else if (frame.t === "seen") {
      if (typeof frame.lastSeen !== "number") return
      if (!this.allowRate(`sig:${session.participantId}`, now, SIGNAL_RATE_LIMIT)) return
      const safeFrame: RealtimeFrame = {
        t: "seen",
        participantId: session.participantId,
        lastSeen: frame.lastSeen,
      }
      this.broadcast(safeFrame, session)
      this.recordSignal(safeFrame)
    }
  }

  // Buffer a signalling frame for polling clients; ephemeral, capped, and
  // pruned to the last 15s so stale typing never replays.
  private recordSignal(frame: RealtimeFrame): void {
    const at = Date.now()
    this.recentSignals.push({ at, frame })
    const cutoff = at - 15000
    this.recentSignals = this.recentSignals.filter((s) => s.at > cutoff).slice(-100)
  }

  private send(session: Session, frame: RealtimeFrame): void {
    try {
      session.ws.send(JSON.stringify(frame))
    } catch {
      this.sessions.delete(session)
    }
  }

  private broadcast(frame: RealtimeFrame, except?: Session): void {
    const data = JSON.stringify(frame)
    for (const s of this.sessions) {
      if (s === except) continue
      try {
        s.ws.send(data)
      } catch {
        this.sessions.delete(s)
      }
    }
  }

  // ---------- expiry alarm ----------

  private async scheduleSweep(): Promise<void> {
    const next = this.core.nextExpiry()
    if (next === null) return
    const existing = await this.state.storage.getAlarm()
    if (existing === null || next < existing) {
      await this.state.storage.setAlarm(Math.max(next, Date.now() + 1000))
    }
  }

  async alarm(): Promise<void> {
    await this.ensureLoaded()
    const now = Date.now()
    // Whole-room self-destruct takes priority over per-message sweeps.
    if (await this.enforceLifetime(now)) return
    const swept = this.core.sweep(now)
    if (swept.removedIds.length) {
      await this.persist()
      if (swept.orphanObjectKeys.length) await this.deleteObjects(swept.orphanObjectKeys)
      this.broadcast({ t: "prune", messageIds: swept.removedIds })
    }
    await this.scheduleSweep()
  }

  /** If the room has passed its self-destruct time, wipe it. Returns true if so. */
  private async enforceLifetime(now: number): Promise<boolean> {
    if (!this.core.isRoomDestroyed(now)) return false
    await this.destroyRoom(now)
    return true
  }

  /** Tear down the room: clear data, delete R2 objects, notify and drop clients. */
  private async destroyRoom(now: number): Promise<void> {
    const keys = this.core.deleteRoom(now)
    await this.persist()
    await this.deleteAllRoomObjects()
    if (keys.length) await this.deleteObjects(keys)
    // Drop any push registrations along with the room data.
    this.pushSubs = new Map()
    await this.state.storage.delete(PUSH_KEY)
    this.broadcast({ t: "room-deleted" })
    for (const s of this.sessions) {
      try {
        s.ws.close(1000, "room closed")
      } catch {
        /* ignore */
      }
    }
    this.sessions.clear()
  }

  // ---------- R2 cleanup ----------

  private async deleteObjects(keys: string[]): Promise<void> {
    if (!keys.length || !this.env.MEDIA) return
    try {
      await this.env.MEDIA.delete(keys)
    } catch {
      /* best effort */
    }
  }

  private async deleteAllRoomObjects(): Promise<void> {
    const room = this.core.getRoom()
    if (!room || !this.env.MEDIA) return
    const prefix = `rooms/${room.roomId}/`
    try {
      let cursor: string | undefined
      do {
        const listed = await this.env.MEDIA.list({ prefix, cursor })
        const keys = listed.objects.map((o) => o.key)
        if (keys.length) await this.env.MEDIA.delete(keys)
        cursor = listed.truncated ? listed.cursor : undefined
      } while (cursor)
    } catch {
      /* best effort */
    }
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  })
}} from "../../shared/types"
import {
  clampRoomLifetime,
  inviteExpiryToMs,
  isValidObjectKey,
  isValidRoomId,
  MAX_ENVELOPE_CHARS,
  MAX_ID_CHARS,
  MAX_MEDIA_BYTES,
  MAX_MESSAGES_PER_ROOM,
  MAX_PUSH_SUBSCRIPTIONS,
  MESSAGE_RATE_LIMIT,
  MESSAGE_RATE_WINDOW_MS,
} from "../../shared/constants"
import { sendWebPush, type PushSubscription, type VapidKeys } from "./webpush"

export interface RoomEnv {
  MEDIA: R2Bucket
  /** VAPID keys for Web Push. When unset, push fan-out is silently disabled. */
  VAPID_PUBLIC_KEY?: string
  VAPID_PRIVATE_KEY?: string
  VAPID_SUBJECT?: string
}

interface Session {
  ws: WebSocket
  participantId: string
}

// A stored Web Push registration. The endpoint + keys are opaque routing data
// for the push service; participantId lets us skip pushing to someone who is
// already connected over a live socket or has a fresh visible-room heartbeat.
interface PushRecord {
  sub: PushSubscription
  participantId: string
  at: number
}

const SNAPSHOT_KEY = "snapshot"
const PUSH_KEY = "pushSubs"
const PUSH_FOREGROUND_SUPPRESS_MS = 30_000
// Signalling frames (typing/seen) are cheap, so they get a more generous rate
// limit than message sends — but they are still bounded to stop floods.
const SIGNAL_RATE_LIMIT = MESSAGE_RATE_LIMIT * 4
// Hard cap on a relayed WebSocket frame. Signal frames are tiny; anything
// larger is dropped without parsing.
const MAX_WS_FRAME_CHARS = 16_384
// Push endpoints are URLs we POST to; keep them sane.
const MAX_PUSH_ENDPOINT_CHARS = 2048
const MAX_PUSH_KEY_CHARS = 512
// A message may reference at most this many media objects.
const MAX_MEDIA_REFS = 10

export class RoomDurableObject {
  private state: DurableObjectState
  private env: RoomEnv
  private core: RoomCore
  private sessions = new Set<Session>()
  // Short-lived signalling frames (typing/seen) buffered so clients on the
  // polling fallback can receive them via the list response. In-memory only.
  private recentSignals: Array<{ at: number; frame: RealtimeFrame }> = []
  // Per-participant send timestamps for rate limiting. In-memory only.
  private rate = new Map<string, number[]>()
  // Lazily-loaded Web Push registrations, keyed by endpoint. Persisted so they
  // survive hibernation; null until first read.
  private pushSubs: Map<string, PushRecord> | null = null
  private loaded = false

  constructor(state: DurableObjectState, env: RoomEnv) {
    this.state = state
    this.env = env
    this.core = new RoomCore()
    this.state.blockConcurrencyWhile(async () => {
      const snap = await this.state.storage.get<RoomSnapshot>(SNAPSHOT_KEY)
      if (snap) this.core = new RoomCore(snap)
      this.loaded = true
    })
  }

  private async persist(): Promise<void> {
    await this.state.storage.put(SNAPSHOT_KEY, this.core.toSnapshot())
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) await this.state.blockConcurrencyWhile(async () => {})
  }

  // ---------- routing ----------

  async fetch(request: Request): Promise<Response> {
    await this.ensureLoaded()
    // Enforce room self-destruct before handling any op, so an expired room
    // behaves as deleted even if the alarm has not fired yet.
    if (await this.enforceLifetime(Date.now())) {
      const url = new URL(request.url)
      if (url.pathname.replace(/^\//, "") === "ws") {
        return new Response("gone", { status: 410 })
      }
    }
    const url = new URL(request.url)
    const op = url.pathname.replace(/^\//, "")

    if (op === "ws") return this.handleWebSocket(request, url)

    let body: Record<string, unknown> = {}
    if (request.method !== "GET") {
      try {
        body = await request.json()
      } catch {
        body = {}
      }
    }

    try {
      switch (op) {
        case "create":
          return this.opCreate(body as unknown as CreateRoomRequest)
        case "validate":
          return this.opValidate(body as unknown as ValidateInviteRequest)
        case "session":
          return this.opSession(body as unknown as SessionRequest)
        case "update":
          return this.opUpdate(body as unknown as UpdateInviteRequest)
        case "set-topic":
          return this.opSetTopic(body as unknown as SetTopicRequest)
        case "owner-action":
          return this.opOwnerAction(body as unknown as OwnerActionRequest)
        case "message":
          return this.opMessage(body as unknown as PostMessageRequest)
        case "edit":
          return this.opEdit(body as unknown as EditMessageRequest)
        case "delete-message":
          return this.opDeleteOwn(body as unknown as DeleteOwnMessageRequest)
        case "list":
          return this.opList(body as unknown as ListMessagesRequest)
        case "prune":
          return this.opPrune(body as unknown as PruneRequest)
        case "react":
          return this.opReact(body as unknown as ReactRequest)
        case "broadcast":
          return this.opBroadcast(body as unknown as BroadcastRequest)
        case "push-subscribe":
          return this.opPushSubscribe(body as unknown as PushSubscribeRequest)
        case "push-unsubscribe":
          return this.opPushUnsubscribe(body as unknown as PushUnsubscribeRequest)
        case "delete":
          return this.opDelete(body as { accessProof: string; ownerProof?: string })
        default:
          return json({ error: "unknown op" }, 404)
      }
    } catch (err) {
      return json({ error: (err as Error).message || "internal error" }, 500)
    }
  }

  // ---------- proof gates ----------

  private async verifyProof(accessProof: string | undefined): Promise<boolean> {
    if (!accessProof || typeof accessProof !== "string") return false
    const hash = await hashAccessProof(accessProof)
    return this.core.verifyHash(hash)
  }

  // Owner proof-of-possession: the raw owner secret hashes to the stored owner
  // verifier. Distinct from the access proof so only the creator can moderate.
  private async verifyOwnerProof(ownerProof: string | undefined): Promise<boolean> {
    if (!ownerProof || typeof ownerProof !== "string") return false
    const hash = await hashAccessProof(ownerProof)
    return this.core.verifyOwner(hash)
  }

  private async hashPresentedProof(proof: string | undefined): Promise<string | null> {
    if (!proof || typeof proof !== "string" || proof.length > 200) return null
    try {
      return await hashAccessProof(proof)
    } catch {
      return null
    }
  }

  private async registerParticipantProof(req: {
    participantId?: string
    participantProof?: string
  }): Promise<boolean> {
    if (!this.validId(req.participantId)) return false
    const proofHash = await this.hashPresentedProof(req.participantProof)
    if (!proofHash) return false
    return this.core.registerParticipant(req.participantId, Date.now(), proofHash)
  }

  private async verifyParticipantProof(req: {
    participantId?: string
    participantProof?: string
  }): Promise<boolean> {
    if (!this.validId(req.participantId)) return false
    const proofHash = await this.hashPresentedProof(req.participantProof)
    if (!proofHash) return false
    return this.core.verifyParticipant(req.participantId, proofHash)
  }

  // Sliding-window per-participant rate limiter. Best-effort; in-memory only.
  private allowRate(id: string, now: number, limit = MESSAGE_RATE_LIMIT): boolean {
    const arr = (this.rate.get(id) ?? []).filter((t) => now - t < MESSAGE_RATE_WINDOW_MS)
    if (arr.length >= limit) {
      this.rate.set(id, arr)
      return false
    }
    arr.push(now)
    this.rate.set(id, arr)
    return true
  }

  // Generic guard for client-supplied identifier strings (message ids,
  // participant ids). Bounded so ids can't be used to bloat storage.
  private validId(id: unknown): id is string {
    return typeof id === "string" && id.length > 0 && id.length <= MAX_ID_CHARS
  }

  // Media refs must point inside THIS room's R2 prefix and match the exact key
  // pattern minted by /api/uploads/sign. Without this check a sender could
  // attach another room's object keys to a message and have our expiry sweeps
  // delete that other room's media (cross-room deletion).
  private validMediaRefs(media: EncryptedMediaRef[] | undefined, roomId: string): boolean {
    if (media === undefined || media === null) return true
    if (!Array.isArray(media) || media.length > MAX_MEDIA_REFS) return false
    for (const ref of media) {
      if (!ref || typeof ref.objectKey !== "string") return false
      if (!isValidObjectKey(ref.objectKey)) return false
      if (!ref.objectKey.startsWith(`rooms/${roomId}/`)) return false
      if (!Number.isInteger(ref.size) || ref.size <= 0 || ref.size > MAX_MEDIA_BYTES) {
        return false
      }
      if (!["image", "video", "audio"].includes(ref.previewKind)) return false
    }
    return true
  }

  // Push endpoints are URLs this object POSTs to, so they must be real https
  // URLs — this stops the worker being used as a generic request proxy (SSRF).
  private validPushEndpoint(endpoint: unknown): endpoint is string {
    if (typeof endpoint !== "string" || !endpoint || endpoint.length > MAX_PUSH_ENDPOINT_CHARS) {
      return false
    }
    try {
      return new URL(endpoint).protocol === "https:"
    } catch {
      return false
    }
  }

  // ---------- operations ----------

  private async opCreate(req: CreateRoomRequest): Promise<Response> {
    const now = Date.now()
    if (!req.roomId || !req.accessProofHash) return json({ error: "missing fields" }, 400)
    // Room ids become R2 key prefixes and DO names; reject anything that could
    // collide with another room's prefix (e.g. ids containing "/").
    if (!isValidRoomId(req.roomId)) return json({ error: "bad room id" }, 400)
    if (typeof req.accessProofHash !== "string" || req.accessProofHash.length > 200) {
      return json({ error: "bad verifier" }, 400)
    }
    if (
      req.ownerKeyHash != null &&
      (typeof req.ownerKeyHash !== "string" || req.ownerKeyHash
