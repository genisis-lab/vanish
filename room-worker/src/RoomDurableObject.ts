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
      (typeof req.ownerKeyHash !== "string" || req.ownerKeyHash
