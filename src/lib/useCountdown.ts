import { useEffect, useState } from "react"
import { formatCountdown } from "./format"

const SECOND = 1_000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * Milliseconds until `formatCountdown` shows a different label for a timer
 * with this much time left: about a second while it counts seconds, and up to
 * a minute, an hour or a day while it counts whole minutes, hours or days.
 */
export function msUntilCountdownChanges(leftMs: number): number {
  if (leftMs <= 0) return Infinity
  const unit = leftMs < MINUTE ? SECOND : leftMs < HOUR ? MINUTE : leftMs < DAY ? HOUR : DAY
  return leftMs - Math.floor(leftMs / unit) * unit + 1
}

/**
 * The countdown label for `expiresAt`, re-rendering only when the label changes.
 * A chat full of messages with a timer then wakes once a minute or less, not
 * once a second per message.
 */
export function useCountdown(expiresAt: number | null | undefined): string | null {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!expiresAt) return
    const delay = msUntilCountdownChanges(expiresAt - Date.now())
    if (!Number.isFinite(delay)) return
    const timer = window.setTimeout(() => setTick((n) => n + 1), delay)
    return () => window.clearTimeout(timer)
  }, [expiresAt, tick])
  return formatCountdown(expiresAt ?? null)
}
