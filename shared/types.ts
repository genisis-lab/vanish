// Shared wire types between the client, Pages Functions, and the Durable Object.
// Nothing here contains plaintext chat content — envelopes are opaque base64url.

export type InviteExpiryOption = "never" | "24h" | "7d"
export type MessageKind = "text" | "media" | "system"

export interface EncryptedMediaRef {
  /** R2 object key, e.g. rooms/<roomId>/<objectId>. Opaque, non-sensitive path. */
  objectKey: string
  /** Encrypted byte length stored in R2 (operational metadata only). */
  size: number
  /** "image" | "video" hint for lazy decrypt UI. The real mime is inside the envelope. */
  previewKind: "image" | "video"
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
}

export interface SessionRequest {
  roomId: string
  accessProof: string
  participantId: string
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
  inviteExpiry?: InviteExpiryOption
  ttlMs?: number
  burnAfterRead?: boolean
  /** Reset the room auto-destruct lifetime (ms from now). 0 disables it. */
  roomLifetimeMs?: number
}

export interface PostMessageRequest {
  roomId: string
  accessProof: string
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

export interface ListMessagesRequest {
  roomId: string
  accessProof: string
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
  previewKind: "image" | "video"
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
  /** specific message ids; omit with all=true to prune everything. */
  messageIds?: string[]
  all?: boolean
}

export interface BroadcastRequest {
  roomId: string
  accessProof: string
  /** Encrypted signalling envelope (typing/presence/reaction), opaque to server. */
  event: { type: string; envelope?: string; participantId: string }
}

export interface ReactRequest {
  roomId: string
  accessProof: string
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
  subscription: WebPushSubscriptionJSON
}

export interface PushUnsubscribeRequest {
  roomId: string
  accessProof: string
  endpoint: string
}

export interface ApiError {
  error: string
}

// ---------- realtime frames (sent over the WebSocket / broadcast) ----------

export type RealtimeFrame =
  | { t: "hello"; serverTime: number; participantCount: number }
  | { t: "message"; message: StoredMessage }
  | { t: "prune"; messageIds: string[]; all?: boolean }
  | { t: "react"; messageId: string; reactionId: string; participantId: string; envelope: string | null }
  | { t: "presence"; participantCount: number }
  | { t: "signal"; event: { type: string; envelope?: string; participantId: string } }
  | { t: "seen"; participantId: string; lastSeen: number }
  | { t: "room-deleted" }
