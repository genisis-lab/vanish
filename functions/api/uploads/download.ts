import type { Env } from "../../types"
import { badRequest, forward, json, readJson } from "../../lib/do"
import { hashAccessProof } from "../../../shared/crypto"
import { isValidObjectKey, isValidRoomId, MEDIA_ENCRYPTED_CHUNK_BYTES } from "../../../shared/constants"
import type { DownloadRequest, ValidateInviteResponse } from "../../../shared/types"

// POST /api/uploads/download — stream an encrypted blob back to an authorized
// key-holder. Decryption happens entirely in the browser. Downloads remain
// available even after the invite expires (existing data is preserved).
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const body = await readJson<DownloadRequest>(request)
  if (!body?.roomId || !body?.accessProof || !body?.objectKey) return badRequest("missing fields")
  if (!isValidRoomId(body.roomId)) return badRequest("bad room id")
  if (!isValidObjectKey(body.objectKey)) return badRequest("bad object key")
  if (!body.objectKey.startsWith(`rooms/${body.roomId}/`)) return json({ error: "forbidden" }, 403)
  const ranged = body.offset !== undefined || body.length !== undefined
  if (
    ranged &&
    (!Number.isInteger(body.offset) ||
      !Number.isInteger(body.length) ||
      body.offset! < 0 ||
      body.length! <= 0 ||
      body.length! > MEDIA_ENCRYPTED_CHUNK_BYTES)
  ) return badRequest("bad range")

  const accessProofHash = await hashAccessProof(body.accessProof)
  const vr = await forward(env, body.roomId, "validate", {
    roomId: body.roomId,
    accessProofHash,
  })
  const v = (await vr.json()) as ValidateInviteResponse
  if (v.status === "invalid" || v.status === "deleted") return json({ error: v.status }, 403)

  let obj: R2ObjectBody | null
  try {
    obj = await env.MEDIA.get(
      body.objectKey,
      ranged ? { range: { offset: body.offset!, length: body.length! } } : undefined,
    )
  } catch {
    return json({ error: "range not satisfiable" }, 416)
  }
  if (!obj) return json({ error: "not found" }, 404)
  const returnedRange = obj.range
  const responseLength =
    ranged
      ? returnedRange && "length" in returnedRange
        ? returnedRange.length
        : body.length!
      : obj.size
  return new Response(obj.body, {
    status: ranged ? 206 : 200,
    headers: {
      "content-type": "application/octet-stream",
      "cache-control": "no-store",
      "content-length": String(responseLength),
    },
  })
}
