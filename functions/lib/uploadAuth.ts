import {
  isValidObjectKey,
  MAX_MEDIA_BYTES,
  MEDIA_ENCRYPTED_CHUNK_BYTES,
} from "../../shared/constants"
import type { Env } from "../types"
import { uploadSecret, verifyUploadToken } from "./auth"
import { badRequest, json } from "./do"

export interface UploadAuthorization {
  objectKey: string
  roomId: string
  size: number
  expiresAt: number
  token: string
}

/** Authenticate a multipart request using the same object/size/expiry-bound
 * HMAC capability issued by /api/uploads/sign. */
export async function authorizeMultipartUpload(
  request: Request,
  env: Env,
): Promise<UploadAuthorization | Response> {
  const secret = uploadSecret(env)
  if (!secret) return json({ error: "uploads not configured" }, 503)

  const token = request.headers.get("x-vanish-token") ?? ""
  const objectKey = request.headers.get("x-vanish-object") ?? ""
  const size = Number(request.headers.get("x-vanish-size") ?? "0")
  const expiresAt = Number(request.headers.get("x-vanish-expires") ?? "0")

  if (!isValidObjectKey(objectKey)) return badRequest("bad object key")
  if (
    !Number.isSafeInteger(size) ||
    size <= 0 ||
    size > MAX_MEDIA_BYTES ||
    size % MEDIA_ENCRYPTED_CHUNK_BYTES !== 0
  ) return badRequest("bad multipart size")
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0) return badRequest("bad token")
  if (!(await verifyUploadToken(secret, objectKey, size, expiresAt, token))) {
    return json({ error: "forbidden" }, 403)
  }

  return { objectKey, roomId: objectKey.split("/")[1], size, expiresAt, token }
}

export function uploadIdFrom(request: Request): string | null {
  const uploadId = request.headers.get("x-vanish-upload-id")
  if (!uploadId || uploadId.length > 512 || /[\u0000-\u001f\u007f]/.test(uploadId)) return null
  return uploadId
}
