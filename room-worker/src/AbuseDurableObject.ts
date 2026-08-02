// Privacy-preserving edge abuse limiter. One object is addressed by a SHA-256
// digest of the connecting IP, so the raw address is never persisted.

const RULES = {
  "room-create": { limit: 10, windowMs: 60 * 60 * 1000 },
  "session-register": { limit: 60, windowMs: 60 * 60 * 1000 },
  "upload-sign": { limit: 60, windowMs: 10 * 60 * 1000 },
} as const

type RuleName = keyof typeof RULES
const REPORTS_KEY = "moderation-reports"
const REPORT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const MAX_REPORTS_PER_ROOM = 100

type StoredReport = {
  version: 1
  reportId: string
  roomDigest: string
  messageId: string
  reporterDigest: string
  reportedParticipantDigest: string
  category: "spam" | "harassment" | "threat" | "other"
  createdAt: number
}

export class AbuseDurableObject {
  constructor(private state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const action = new URL(request.url).searchParams.get("action")
    if (action === "record-report" && request.method === "POST") {
      const report = await request.json<Partial<StoredReport>>().catch(() => null)
      if (
        report?.version !== 1 ||
        typeof report.reportId !== "string" ||
        typeof report.roomDigest !== "string" ||
        typeof report.messageId !== "string" ||
        typeof report.reporterDigest !== "string" ||
        typeof report.reportedParticipantDigest !== "string" ||
        !["spam", "harassment", "threat", "other"].includes(String(report.category)) ||
        typeof report.createdAt !== "number"
      ) return Response.json({ error: "bad report" }, { status: 400 })
      const reports = (await this.state.storage.get<StoredReport[]>(REPORTS_KEY)) ?? []
      if (!reports.some((item) => item.reportId === report.reportId)) {
        reports.push(report as StoredReport)
        await this.state.storage.put(REPORTS_KEY, reports.slice(-MAX_REPORTS_PER_ROOM))
      }
      await this.state.storage.setAlarm(Date.now() + REPORT_RETENTION_MS)
      return Response.json({ ok: true })
    }
    const ruleName = action as RuleName | null
    if (!ruleName || !(ruleName in RULES)) return Response.json({ error: "bad action" }, { status: 400 })
    const rule = RULES[ruleName]
    const now = Date.now()
    const key = `rate:${ruleName}`
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

  async alarm(): Promise<void> {
    await this.state.storage.deleteAll()
  }
}
