import type { Env } from "../../../types"
import { badRequest, json } from "../../../lib/do"
import { authorizeMultipartUpload, uploadIdFrom } from "../../../lib/uploadAuth"

// DELETE /api/uploads/multipart/abort — best-effort cleanup when encryption or
// networking fails. R2 also expires incomplete multipart uploads after 7 days.
export const onRequestDelete: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await authorizeMultipartUpload(request, env)
  if (auth instanceof Response) return auth
  const uploadId = uploadIdFrom(request)
  if (!uploadId) return badRequest("bad upload id")
  try {
    await env.MEDIA.resumeMultipartUpload(auth.objectKey, uploadId).abort()
    return new Response(null, { status: 204 })
  } catch {
    return json({ error: "could not abort multipart upload" }, 502)
  }
}
