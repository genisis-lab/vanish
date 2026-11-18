import { describe, expect, it } from "vitest"
import { msUntilCountdownChanges } from "../../src/lib/useCountdown"
import { dayKey, formatCountdown, formatDay } from "../../src/lib/format"

describe("msUntilCountdownChanges", () => {
  it("waits until the shown label actually changes", () => {
    const cases: [number, number][] = [
      [5_300, 301], // 5s -> 4s
      [59_999, 1_000], // 59s -> 58s
      [60_000, 1], // 1m -> 59s
      [90_000, 30_001], // 1m -> 59s
      [3 * 3_600_000 + 5, 6], // 3h -> 2h
      [2 * 86_400_000 + 1_000, 1_001], // 2d -> 1d
    ]
    for (const [left, wait] of cases) {
      expect(msUntilCountdownChanges(left), `left ${left}`).toBe(wait)
      const now = 1_000_000
      const label = formatCountdown(now + left, now)
      expect(formatCountdown(now + left, now + wait - 1)).toBe(label)
      expect(formatCountdown(now + left, now + wait)).not.toBe(label)
    }
  })

  it("stops once expired", () => {
    expect(msUntilCountdownChanges(0)).toBe(Infinity)
    expect(msUntilCountdownChanges(-5)).toBe(Infinity)
  })
})

describe("formatDay", () => {
  const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).getTime()
  const now = at(2026, 11, 18, 9)

  it("names today and yesterday by local calendar day", () => {
    expect(formatDay(at(2026, 11, 18, 0), now)).toBe("Today")
    expect(formatDay(at(2026, 11, 17, 23), now)).toBe("Yesterday")
    expect(formatDay(at(2026, 11, 16, 23), now)).not.toBe("Yesterday")
  })

  it("adds the year only for other years", () => {
    expect(formatDay(at(2026, 11, 2), now)).not.toMatch(/2026/)
    expect(formatDay(at(2025, 11, 2), now)).toMatch(/2025/)
  })

  it("groups times on the same local day together", () => {
    expect(dayKey(at(2026, 11, 18, 0))).toBe(dayKey(at(2026, 11, 18, 23)))
    expect(dayKey(at(2026, 11, 18, 23))).not.toBe(dayKey(at(2026, 11, 19, 0)))
  })
})
