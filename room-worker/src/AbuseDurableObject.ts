// Privacy-preserving edge abuse limiter. One object is addressed by a SHA-256
// digest of the connecting IP, so the raw address is never persisted.

const RULES = {
  "room-create": { limit: 10, windowMs: 60 * 60 * 1000 },
  "session-register": { limit: 60, windowMs: 60 * 60 * 1000 },
  "upload-sign": { limit: 60, windowMs: 10 * 60 * 1000 },
} as const

type RuleName = keyof typeof RULES

export class AbuseDurableObject {
  constructor(private state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const action = new URL(request.url).searchParams.get("action") as RuleName | null
    if (!action || !(action in RULES)) return Response.json({ error: "bad action" }, { status: 400 })
    const rule = RULES[action]
    const now = Date.now()
    const key = `rate:${action}`
    const previous = (await this.state.storage.get<number[]>(key)) ?? []
    const active = previous.filter((at) => now - at < rule.windowMs)
    if (active.length >= rule.limit) {
      await this.state.storage.put(key, active)
      return Response.json(
        { allowed: false, retryAfterMs: Math.max(1000, rule.windowMs - (now - active[0])) },
        { status: 429 },
      )
    }
    active.push(now)
    await this.state.storage.put(key, active)
    return Response.json({ allowed: true })
  }
}
