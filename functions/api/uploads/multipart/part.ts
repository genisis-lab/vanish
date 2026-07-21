import type { Env } from "../../../types"
import { badRequest, json } from "../../../lib/do"
import { authorizeMultipartUpload, uploadIdFrom } from "../../../lib/uploadAuth"
import { MEDIA_ENCRYPTED_CHUNK_BYTES } from "../../../../shared/constants"
import type { MultipartUploadedPart } from "../../../../shared/types"

// PUT /api/uploads/multipart/part — stream one independently encrypted part to
// R2. Parts stay well below every Cloudflare plan's inbound request limit.
export const onRequestPut: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await authorizeMultipartUpload(request, env)
  if (auth instanceof Response) return auth
  const uploadId = uploadIdFrom(request)
  const partNumber = Number(request.headers.get("x-vanish-part") ?? "0")
  const partCount = auth.size / MEDIA_ENCRYPTED_CHUNK_BYTES
  if (!uploadId) return badRequest("bad upload id")
  if (!Number.isSafeInteger(partNumber) || partNumber < 1 || partNumber > partCount) {
    return badRequest("bad part number")
  }
  if (Number(request.headers.get("content-length") ?? "0") !== MEDIA_ENCRYPTED_CHUNK_BYTES) {
    return json({ error: "bad part size" }, 400)
  }
  if (!request.body) return badRequest("missing body")

  try {
    const upload = env.MEDIA.resumeMultipartUpload(auth.objectKey, uploadId)
    const part = await upload.uploadPart(partNumber, request.body)
    const response: MultipartUploadedPart = { partNumber: part.partNumber, etag: part.etag }
    return json(response)
  } catch {
    return json({ error: "multipart part upload failed" }, 502)
  }
}
