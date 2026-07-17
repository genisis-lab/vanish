import type { Env } from "../types"
import { json } from "./do"

export type AbuseAction = "room-create" | "upload-sign"

async function clientDigest(request: Request): Promise<string> {
  const raw =
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for")?.split(",", 1)[0]?.trim() ||
    "local-development"
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
