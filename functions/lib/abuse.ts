import type { Env } from "../types"
import { json } from "./do"

export type AbuseAction = "room-create" | "session-register" | "upload-sign"

async function clientDigest(request: Request): Promise<string> {
  // Cloudflare overwrites CF-Connecting-IP at the edge. Do not trust forwarded
  // headers supplied by clients when the platform header is absent.
  const raw = request.headers.get("cf-connecting-ip") || "unknown-client"
  const bytes = new TextEncoder().encode(`vanish-abuse-v1:${raw}`)
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")
}

export async function enforceAbuseLimit(
  env: Env,
  request: Request,
  action: AbuseAction,
): Promise<Response | null> {
  if (env.E2E_MODE === "1") return null
  const id = env.ABUSE.idFromName(await clientDigest(request))
  const response = await env.ABUSE.get(id).fetch(`https://vanish.do/check?action=${action}`)
  if (response.ok) return null
  const payload = (await response.json().catch(() => ({}))) as { retryAfterMs?: number }
  const retryAfter = Math.max(1, Math.ceil((payload.retryAfterMs ?? 60_000) / 1000))
  const limited = json({ error: "rate limited", retryAfter }, 429)
  limited.headers.set("retry-after", String(retryAfter))
  return limited
}
