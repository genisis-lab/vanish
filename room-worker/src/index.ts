// Companion Worker entry. Exports the Durable Object class so Pages can bind to
// it via `script_name`. The default fetch handler exposes only a health check;
// room operations must cross the validated Pages service-binding boundary.

import { RoomDurableObject, type ModerationReport, type RoomEnv } from "./RoomDurableObject"
import { AbuseDurableObject } from "./AbuseDurableObject"

export { AbuseDurableObject, RoomDurableObject }

export interface Env extends RoomEnv {
  ROOM: DurableObjectNamespace
  ABUSE: DurableObjectNamespace
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ ok: true, service: "vanish-room" }), {
        headers: { "content-type": "application/json" },
      })
    }
    // Room operations are intentionally not routed through this public fetch
    // handler. Pages reaches the namespaces through service bindings, preserving
    // validation and rate limits at the only supported external boundary.
    void env
    return new Response("not found", { status: 404 })
  },
  async queue(batch: MessageBatch, env: Env): Promise<void> {
    for (const message of batch.messages) {
      const report = message.body as Partial<ModerationReport> | null
      if (
        report?.version !== 1 ||
        typeof report.reportId !== "string" ||
        typeof report.roomDigest !== "string" ||
        typeof report.messageId !== "string" ||
        typeof report.category !== "string"
      ) {
        message.ack()
        continue
      }
      try {
        const id = env.ABUSE.idFromName(`reports:${report.roomDigest}`)
        const response = await env.ABUSE.get(id).fetch("https://vanish.do/?action=record-report", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(report),
        })
        if (!response.ok) throw new Error(`report store returned ${response.status}`)
        // Structured operational metadata only. Never log request headers,
        // message envelopes, media, IP addresses, or room/access secrets.
        console.warn(JSON.stringify({
          event: "moderation.report.received",
          reportId: report.reportId,
          roomDigest: report.roomDigest,
          messageId: report.messageId,
          reporterDigest: report.reporterDigest,
          reportedParticipantDigest: report.reportedParticipantDigest,
          category: report.category,
          createdAt: report.createdAt,
        }))
        message.ack()
      } catch (error) {
        console.error(JSON.stringify({
          event: "moderation.report.persist_failed",
          reportId: report.reportId,
          error: error instanceof Error ? error.message : String(error),
        }))
        message.retry({ delaySeconds: Math.min(300, 30 * 2 ** message.attempts) })
      }
    }
  },
}
