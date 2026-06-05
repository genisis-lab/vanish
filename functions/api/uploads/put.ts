import type { Env } from "../../types"
import { badRequest, json } from "../../lib/do"
import { uploadSecret, verifyUploadToken } from "../../lib/auth"
import { MAX_MEDIA_BYTES } from "../../../shared/constants"

// POST /api/uploads/put — store the encrypted blob in R2, gated by the HMAC
// token issued by /api/uploads/sign. Only ciphertext ever reaches this handler.
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const url = new URL(request.url)
  const token = request.headers.get("x-vanish-token") || url.searchParams.get("token") || ""
  const objectKey = request.headers.get("x-vanish-object") || url.searchParams.get("key") || ""
  const size = Number(request.headers.get("x-vanish-size") || url.searchParams.get("size") || "0")
  const expiresAt = Number(request.headers.get("x-vanish-expires") || url.searchParams.get("exp") || "0")

  if (!objectKey.startsWith("rooms/")) return badRequest("bad object key")
  if (!size || size > MAX_MEDIA_BYTES) return badRequest("bad size")
  if (!(await verifyUploadToken(uploadSecret(env), objectKey, size, expiresAt, token))) {
    return json({ error: "forbidden" }, 403)
  }

  const buf = await request.arrayBuffer()
  if (buf.byteLength !== size) return badRequest("size mismatch")
  await env.MEDIA.put(objectKey, buf, {
    httpMetadata: { contentType: "application/octet-stream" },
  })
  return json({ ok: true, objectKey })
}
