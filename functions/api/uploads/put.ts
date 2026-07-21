import type { Env } from "../../types"
import { badRequest, forward, json } from "../../lib/do"
import { uploadSecret, verifyUploadToken } from "../../lib/auth"
import { isValidObjectKey, MAX_SINGLE_UPLOAD_BYTES } from "../../../shared/constants"

// POST /api/uploads/put — store the encrypted blob in R2, gated by the HMAC
// token issued by /api/uploads/sign. Only ciphertext ever reaches this handler.
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const secret = uploadSecret(env)
  if (!secret) return json({ error: "uploads not configured" }, 503)

  // Bearer capabilities are accepted only in headers so they cannot leak via
  // request URLs, proxy logs, analytics, or Referer headers.
  const token = request.headers.get("x-vanish-token") || ""
  const objectKey = request.headers.get("x-vanish-object") || ""
  const size = Number(request.headers.get("x-vanish-size") || "0")
  const expiresAt = Number(request.headers.get("x-vanish-expires") || "0")

  // Tokens are bound to a specific key minted by /sign; reject anything that
  // does not match the exact mint pattern (defense in depth against key games).
  if (!isValidObjectKey(objectKey)) return badRequest("bad object key")
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_SINGLE_UPLOAD_BYTES) return badRequest("bad size")
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0) return badRequest("bad token")
  if (!(await verifyUploadToken(secret, objectKey, size, expiresAt, token))) {
    return json({ error: "forbidden" }, 403)
  }

  const contentLength = Number(request.headers.get("content-length") ?? "0")
  if (!Number.isSafeInteger(contentLength) || contentLength !== size) {
    return badRequest("bad content length")
  }
  if (!request.body) return badRequest("missing body")

  const roomId = objectKey.split("/")[1]
  const existing = await env.MEDIA.head(objectKey)
  if (existing) {
    if (existing.size !== size) return json({ error: "object already exists" }, 409)
    const completed = await forward(env, roomId, "complete-upload", { objectKey, size })
    return completed.ok ? json({ ok: true, objectKey }) : completed
  }
  const claimed = await forward(env, roomId, "claim-upload", { objectKey, size })
  if (!claimed.ok) return claimed
  await env.MEDIA.put(objectKey, request.body, {
    httpMetadata: { contentType: "application/octet-stream" },
  })
  const stored = await env.MEDIA.head(objectKey)
  if (!stored || stored.size !== size) {
    await env.MEDIA.delete(objectKey)
    return badRequest("size mismatch")
  }
  const completed = await forward(env, roomId, "complete-upload", { objectKey, size })
  if (!completed.ok) return completed
  return json({ ok: true, objectKey })
}
