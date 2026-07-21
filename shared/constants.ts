import type { InviteExpiryOption } from "./types"

export const DEFAULT_MESSAGE_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours
export const MIN_MESSAGE_TTL_MS = 5 * 1000 // 5 seconds (burn-style)
export const MAX_MESSAGE_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days
const MIB = 1024 * 1024
const GIB = 1024 * MIB

/** Plaintext limit presented to users. Large files use encrypted multipart upload. */
export const MAX_MEDIA_PLAINTEXT_BYTES = 2 * GIB
/** Fixed plaintext size encrypted into every multipart part. */
export const MEDIA_CHUNK_BYTES = 16 * MIB
/** encryptBytes layout: version (1) + IV (12) + AES-GCM tag (16). */
export const MEDIA_CHUNK_ENVELOPE_OVERHEAD = 29
export const MEDIA_ENCRYPTED_CHUNK_BYTES = MEDIA_CHUNK_BYTES + MEDIA_CHUNK_ENVELOPE_OVERHEAD
export const MAX_MEDIA_CHUNKS = Math.ceil(MAX_MEDIA_PLAINTEXT_BYTES / MEDIA_CHUNK_BYTES)
/** Maximum server-stored ciphertext for one 2 GiB padded, chunk-encrypted file. */
export const MAX_MEDIA_BYTES = MAX_MEDIA_CHUNKS * MEDIA_ENCRYPTED_CHUNK_BYTES
/** Small files retain the original single-object format for compatibility. */
export const MULTIPART_MEDIA_THRESHOLD_BYTES = 8 * MIB
export const MAX_SINGLE_UPLOAD_BYTES = 16 * MIB
export const UPLOAD_TOKEN_TTL_MS = 5 * 60 * 1000
export const MULTIPART_UPLOAD_TOKEN_TTL_MS = 6 * 60 * 60 * 1000
/** Total encrypted media retained by one room, including pending uploads. */
export const MAX_ROOM_MEDIA_BYTES = 5 * GIB

/** Maximum JSON request body accepted by Pages Functions. */
export const MAX_JSON_BODY_BYTES = 256 * 1024

// ---------- abuse / resource controls (enforced in the Durable Object) ----------

/** Max characters in a single message envelope (base64url); ~150 KB of bytes. */
export const MAX_ENVELOPE_CHARS = 200_000
/** Rolling per-room message cap; oldest messages are pruned beyond this. */
export const MAX_MESSAGES_PER_ROOM = 2000
/** Per-participant send rate limit. */
export const MESSAGE_RATE_LIMIT = 30
export const MESSAGE_RATE_WINDOW_MS = 10_000
/** Bound persistent and live per-room state against invite-holder abuse. */
export const MAX_PARTICIPANTS_PER_ROOM = 1024
export const MAX_UPLOAD_RESERVATIONS = 256
export const MAX_REACTIONS_PER_MESSAGE = 64
export const MAX_WS_CONNECTIONS_PER_ROOM = 128
export const MAX_WS_CONNECTIONS_PER_PARTICIPANT = 4

// ---------- identifier validation (shared by Pages Functions + the DO) ----------

/** Room ids are base64url(16 bytes) = 22 chars; accept a small range for safety. */
export const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{10,64}$/

export function isValidRoomId(id: unknown): id is string {
  return typeof id === "string" && ROOM_ID_PATTERN.test(id)
}

/** R2 object keys minted by /api/uploads/sign: rooms/<roomId>/<32 hex chars>. */
export const OBJECT_KEY_PATTERN = /^rooms\/[A-Za-z0-9_-]{10,64}\/[0-9a-f]{32}$/

export function isValidObjectKey(key: unknown): key is string {
  return typeof key === "string" && OBJECT_KEY_PATTERN.test(key)
}

/** Generic ceiling for client-supplied ids (message ids, participant ids). */
export const MAX_ID_CHARS = 128

/** 32 random/hash bytes encoded without base64 padding. */
export const PROOF_PATTERN = /^[A-Za-z0-9_-]{43}$/

export function isValidProof(value: unknown): value is string {
  return typeof value === "string" && PROOF_PATTERN.test(value)
}

/** Cap on stored Web Push registrations per room (oldest evicted beyond this). */
export const MAX_PUSH_SUBSCRIPTIONS = 32

export const TTL_PRESETS: { label: string; ms: number }[] = [
  { label: "30 seconds", ms: 30 * 1000 },
  { label: "5 minutes", ms: 5 * 60 * 1000 },
  { label: "1 hour", ms: 60 * 60 * 1000 },
  { label: "8 hours", ms: 8 * 60 * 60 * 1000 },
  { label: "24 hours", ms: 24 * 60 * 60 * 1000 },
  { label: "7 days", ms: 7 * 24 * 60 * 60 * 1000 },
]

// ---------- whole-room auto-destruct ----------

/** Hard ceiling on how long a room can live before it self-destructs. */
export const MAX_ROOM_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

/** Selectable room lifetimes. ms === 0 means "no auto-destruct". */
export const ROOM_LIFETIME_PRESETS: { label: string; ms: number }[] = [
  { label: "Off — until deleted", ms: 0 },
  { label: "1 hour", ms: 60 * 60 * 1000 },
  { label: "8 hours", ms: 8 * 60 * 60 * 1000 },
  { label: "24 hours", ms: 24 * 60 * 60 * 1000 },
  { label: "7 days", ms: 7 * 24 * 60 * 60 * 1000 },
]

/** Clamp a requested room lifetime; returns 0 when disabled/invalid. */
export function clampRoomLifetime(ms: number | undefined): number {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return 0
  return Math.min(MAX_ROOM_LIFETIME_MS, Math.floor(ms))
}

export function inviteExpiryToMs(option: InviteExpiryOption, now: number): number | null {
  switch (option) {
    case "24h":
      return now + 24 * 60 * 60 * 1000
    case "7d":
      return now + 7 * 24 * 60 * 60 * 1000
    case "never":
    default:
      return null
  }
}

export function clampTtl(ms: number | undefined, fallback = DEFAULT_MESSAGE_TTL_MS): number {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return fallback
  return Math.min(MAX_MESSAGE_TTL_MS, Math.max(MIN_MESSAGE_TTL_MS, Math.floor(ms)))
}
