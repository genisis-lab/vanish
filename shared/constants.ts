import type { InviteExpiryOption } from "./types"

export const DEFAULT_MESSAGE_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours
export const MIN_MESSAGE_TTL_MS = 5 * 1000 // 5 seconds (burn-style)
export const MAX_MESSAGE_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days
export const MAX_MEDIA_BYTES = 50 * 1024 * 1024 // 50 MB encrypted blob ceiling
export const UPLOAD_TOKEN_TTL_MS = 5 * 60 * 1000

// ---------- abuse / resource controls (enforced in the Durable Object) ----------

/** Max characters in a single message envelope (base64url); ~150 KB of bytes. */
export const MAX_ENVELOPE_CHARS = 200_000
/** Rolling per-room message cap; oldest messages are pruned beyond this. */
export const MAX_MESSAGES_PER_ROOM = 2000
/** Per-participant send rate limit. */
export const MESSAGE_RATE_LIMIT = 30
export const MESSAGE_RATE_WINDOW_MS = 10_000

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
  if (!ms || Number.isNaN(ms) || ms <= 0) return 0
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
  if (!ms || Number.isNaN(ms)) return fallback
  return Math.min(MAX_MESSAGE_TTL_MS, Math.max(MIN_MESSAGE_TTL_MS, Math.floor(ms)))
}
