import type { Env } from "../../../types"
import { badRequest, json, readJson } from "../../../lib/do"
import { authorizeMultipartUpload, uploadIdFrom } from "../../../lib/uploadAuth"
import { MEDIA_ENCRYPTED_CHUNK_BYTES } from "../../../../shared/constants"
import type { MultipartCompleteRequest, MultipartUploadedPart } from "../../../../shared/types"

function validParts(parts: unknown, expected: number): parts is MultipartUploadedPart[] {
  if (!Array.isArray(parts) || parts.length !== expected) return false
  const seen = new Set<number>()
  for (const part of parts) {
    if (
      !part ||
      !Number.isInteger(part.partNumber) ||
      part.partNumber < 1 ||
      part.partNumber > expected ||
      seen.has(part.partNumber) ||
      typeof part.etag !== "string" ||
      !/^[A-Za-z0-9_="-]{1,512}$/.test(part.etag)
    ) return false
    seen.add(part.partNumber)
  }
  return true
}

// POST /api/uploads/multipart/complete — atomically publish the R2 object only
// after every expected part is present, then verify the final ciphertext size.
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await authorizeMultipartUpload(request, env)
  if (auth instanceof Response) return auth
  const uploadId = uploadIdFrom(request)
  if (!uploadId) return badRequest("bad upload id")
  const contentLength = Number(request.headers.get("content-length") ?? "0")
  if (!Number.isInteger(contentLength) || contentLength <= 0 || contentLength > 128 * 1024) {
    return json({ error: "completion payload too large" }, 413)
  }
  const body = await readJson<MultipartCompleteRequest>(request)
  const expected = auth.size / MEDIA_ENCRYPTED_CHUNK_BYTES
  if (!body || !validParts(body.parts, expected)) return badRequest("bad multipart parts")

  try {
    const existing = await env.MEDIA.head(auth.objectKey)
    if (existing) {
      return existing.size === auth.size
        ? json({ ok: true, objectKey: auth.objectKey })
        : json({ error: "object already exists" }, 409)
    }
    const upload = env.MEDIA.resumeMultipartUpload(auth.objectKey, uploadId)
    const object = await upload.complete([...body.parts].sort((a, b) => a.partNumber - b.partNumber))
    if (object.size !== auth.size) {
      await env.MEDIA.delete(auth.objectKey)
      return badRequest("size mismatch")
    }
    return json({ ok: true, objectKey: auth.objectKey })
  } catch {
    return json({ error: "could not complete multipart upload" }, 502)
  }
}
