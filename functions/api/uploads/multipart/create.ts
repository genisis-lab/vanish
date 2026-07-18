import type { Env } from "../../../types"
import { forward, json } from "../../../lib/do"
import { authorizeMultipartUpload } from "../../../lib/uploadAuth"
import type { MultipartCreateResponse } from "../../../../shared/types"

// POST /api/uploads/multipart/create — claim the room reservation and create
// the R2 multipart upload. The client retains uploadId and the returned part
// ETags until completion, as recommended by R2's multipart API.
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await authorizeMultipartUpload(request, env)
  if (auth instanceof Response) return auth

  const claimed = await forward(env, auth.roomId, "claim-upload", {
    objectKey: auth.objectKey,
    size: auth.size,
  })
  if (!claimed.ok) return claimed
  if (await env.MEDIA.head(auth.objectKey)) return json({ error: "object already exists" }, 409)

  try {
    const upload = await env.MEDIA.createMultipartUpload(auth.objectKey, {
      httpMetadata: { contentType: "application/octet-stream" },
    })
    const response: MultipartCreateResponse = { uploadId: upload.uploadId }
    return json(response)
  } catch {
    return json({ error: "could not start multipart upload" }, 502)
  }
}
