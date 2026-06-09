import type { Env } from "../../types"
import { badRequest, forward, json, readJson } from "../../lib/do"
import { hashAccessProof } from "../../../shared/crypto"
import { signUploadToken, uploadSecret } from "../../lib/auth"
import { isValidRoomId, MAX_MEDIA_BYTES, UPLOAD_TOKEN_TTL_MS } from "../../../shared/constants"
import type {
  SignUploadRequest,
  SignUploadResponse,
  ValidateInviteResponse,
} from "../../../shared/types"

function randomId(): string {
  const b = new Uint8Array(16)
  crypto.getRandomValues(b)
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")
}

// POST /api/uploads/sign — authorize a single encrypted-blob upload to R2.
// Returns an opaque object key + short-lived HMAC token. The bytes uploaded
// against this token are already ciphertext.
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const secret = uploadSecret(env)
  if (!secret) return json({ error: "uploads not configured" }, 503)

  const body = await readJson<SignUploadRequest>(request)
  if (!body?.roomId || !body?.accessProof || !body?.size) return badRequest("missing fields")
  if (!isValidRoomId(body.roomId)) return badRequest("bad room id")
  if (!Number.isInteger(body.size) || body.size <= 0) return badRequest("bad size")
  if (body.size > MAX_MEDIA_BYTES) return json({ error: "payload too large" }, 413)

  const accessProofHash = await hashAccessProof(body.accessProof)
  const vr = await forward(env, body.roomId, "validate", {
    roomId: body.roomId,
    accessProofHash,
  })
  const v = (await vr.json()) as ValidateInviteResponse
  if (v.status !== "valid") {
    return json({ error: v.status }, v.status === "expired" ? 410 : 403)
  }

  const objectKey = `rooms/${body.roomId}/${randomId()}`
  const expiresAt = Date.now() + UPLOAD_TOKEN_TTL_MS
  const token = await signUploadToken(secret, objectKey, body.size, expiresAt)
  const res: SignUploadResponse = { objectKey, uploadUrl: "/api/uploads/put", token, expiresAt }
  return json(res)
}
