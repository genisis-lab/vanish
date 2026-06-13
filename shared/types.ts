// Shared wire types between the client, Pages Functions, and the Durable Object.
// Nothing here contains plaintext chat content — envelopes are opaque base64url.

export type InviteExpiryOption = "never" | "24h" | "7d"
export type MessageKind = "text" | "media" | "system"

export interface EncryptedMediaRef {
  /** R2 object key, e.g. rooms/<roomId>/<objectId>. Opaque, non-sensitive path. */
  objectKey: string
  /** Encrypted byte length stored in R2 (operational metadata only). */
  size: number
  /** "image" | "video" | "audio" hint for lazy decrypt UI. Real mime is inside the envelope. */
  previewKind: "image" | "video" | "audio"
}

export interface StoredMessage {
  id: string
  roomId: string
  participantId: string
  /** Optional legacy two-party sender slot ("a" | "b"); unused for multi-party rooms. */
  senderSlot?: string | null
  /** Opaque AES-GCM envelope (base64url). Server can never read it. */
  envelope: string
  /** Encrypted media references. Bytes live in R2; manifest detail is in the envelope. */
  media?: EncryptedMediaRef[]
  kind: MessageKind
  createdAt: number
  expiresAt: number | null
  /** Encrypted reaction envelopes keyed by reaction id. */
  reactions?: Record<string, { participantId: string; envelope: string }>
  /** burn-after-read marker: removed once delivered to a reader other than sender. */
  burn?: boolean
  /** Server time the author last edited this message's envelope, if ever. */
  editedAt?: number | null
  /** Soft-delete tombstone time: the author removed this message for everyone. */
  deletedAt?: number | null
}

export interface PublicRoomState {
  roomId: string
  createdAt: number
  deletedAt: number | null
  inviteExpiresAt: number | null
  defaultTtlMs: number
  burnAfterRead: boolean
  participantCount: number
  /** When set, the entire room self-destructs at this timestamp. */
  destroyAt: number | null
  /** Opaque encrypted room topic/name envelope (base64url) or null. Server can't read it. */
  topicEnvelope: string | null
  /** True when the room has a registered owner credential (owner controls available). */
  hasOwner: boolean
  /** Participant ids the owner has banned. Opaque pseudonymous ids. */
  banned: string[]
}

// ---------- request/response payloads ----------

export interface CreateRoomRequest {
  roomId: string
  accessProofHash: string
  inviteExpiry: InviteExpiryOption
  ttlMs?: number
  burnAfterRead?: boolean
  /** Whole-room auto-destruct lifetime in ms from creation. 0/undefined = off. */
  roomLifetimeMs?: number
  /** SHA-256(ownerSecret) registering the creator as owner. Optional/legacy-safe. */
  ownerKeyHash?: string
  /** Optional initial encrypted room topic envelope. */
  topicEnvelope?: string | null
}

export interface SessionRequest {
  roomId: string
  accessProof: string
  participantId: string
  /** Per-device proof binding this participant id to the caller. */
  participantProof: string
}

export interface ValidateInviteRequest {
  roomId: string
  accessProofHash: string
}

export interface ValidateInviteResponse {
  status: "valid" | "invalid" | "expired" | "deleted"
  room?: PublicRoomState
}

export interface UpdateInviteRequest {
  roomId: string
  accessProof: string
  /** Owner proof-of-possession; changing room policy is owner-gated. */
  ownerProof: string
  inviteExpiry?: InviteExpiryOption
  ttlMs?: number
  burnAfterRead?: boolean
  /** Reset the room auto-destruct lifetime (ms from now). 0 disables it. */
  roomLifetimeMs?: number
}

/** Owner-gated: set or clear the encrypted room topic/name. */
export interface SetTopicRequest {
  roomId: string
  accessProof: string
  /** Proof-of-possession of the owner secret (raw). Server hashes to compare. */
  ownerProof: string
  /** New opaque encrypted topic envelope, or null to clear. */
  topicEnvelope: string | null
}

export type OwnerActionType = "ban" | "unban" | "clear" | "destroy"

/** Owner-gated moderation actions. */
export interface OwnerActionRequest {
  roomId: string
  accessProof: string
  ownerProof: string
  action: OwnerActionType
  /** Target participant id for ban/unban. */
  targetParticipantId?: string
}

export interface PostMessageRequest {
  roomId: string
  accessProof: string
  participantProof: string
  message: {
    id: string
    participantId: string
    senderSlot?: string | null
    envelope: string
    media?: EncryptedMediaRef[]
    kind: MessageKind
    ttlMs?: number
    burn?: boolean
  }
}

export interface EditMessageRequest {
  roomId: string
  accessProof: string
  participantProof: string
  messageId: string
  participantId: string
  /** New opaque AES-GCM envelope (re-signed by the author). */
  envelope: string
  kind?: MessageKind
}

export interface DeleteOwnMessageRequest {
  roomId: string
  accessProof: string
  participantProof: string
  messageId: string
  participantId: string
}

export interface ListMessagesRequest {
  roomId: string
  accessProof: string
  participantId: string
  participantProof: string
  since?: number
  markReadFor?: string
  /** Return buffered signalling frames (typing/seen) newer than this server time. */
  signalsSince?: number
}

export interface ListMessagesResponse {
  messages: StoredMessage[]
  room: PublicRoomState
  serverTime: number
  /** Recent signalling frames (typing/seen) for clients on the polling fallback. */
  signals?: RealtimeFrame[]
}

export interface SignUploadRequest {
  roomId: string
  accessProof: string
  size: number
  previewKind: "image" | "video" | "audio"
}

export interface SignUploadResponse {
  objectKey: string
  uploadUrl: string
  token: string
  expiresAt: number
}

export interface DownloadRequest {
  roomId: string
  accessProof: string
  objectKey: string
}

export interface PruneRequest {
  roomId: string
  accessProof: string
  /** Required for member pruning; only messages authored by this participant are removed. */
  participantId?: string
  participantProof?: string
  /** Required when all=true or when an owner removes arbitrary message ids. */
  ownerProof?: string
  /** specific message ids; omit with all=true to prune everything. */
  messageIds?: string[]
  all?: boolean
}

export interface BroadcastRequest {
  roomId: string
  accessProof: string
  participantId: string
  participantProof: string
  /** Encrypted signalling envelope (typing/presence/reaction), opaque to server. */
  event: { type: string; envelope?: string; participantId: string }
}

export interface ReactRequest {
  roomId: string
  accessProof: string
  participantProof: string
  messageId: string
  reactionId: string
  participantId: string
  envelope: string | null
}

// ---------- web push ----------

/** A browser Web Push registration (PushSubscription.toJSON shape). Opaque routing data. */
export interface WebPushSubscriptionJSON {
  endpoint: string
  keys: { p256dh: string; auth: string }
}

export interface PushSubscribeRequest {
  roomId: string
  accessProof: string
  participantId: string
  participantProof: string
  subscription: WebPushSubscriptionJSON
}

export interface PushUnsubscribeRequest {
  roomId: string
  accessProof: string
  participantId: string
  participantProof: string
  endpoint: string
}

export interface ApiError {
  error: string
}

// ---------- realtime frames (sent over the WebSocket / broadcast) ----------

export type RealtimeFrame =
  | { t: "hello"; serverTime: number; participantCount: number }
  | { t: "message"; message: StoredMessage }
  | { t: "edit"; message: StoredMessage }
  | { t: "prune"; messageIds: string[]; all?: boolean }
  | { t: "react"; messageId: string; reactionId: string; participantId: string; envelope: string | null }
  | { t: "presence"; participantCount: number }
  | { t: "signal"; event: { type: string; envelope?: string; participantId: string } }
  | { t: "seen"; participantId: string; lastSeen: number }
  | { t: "room-updated"; room: PublicRoomState }
  | { t: "banned"; participantId: string }
  | { t: "room-deleted" }
