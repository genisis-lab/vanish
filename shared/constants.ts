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
