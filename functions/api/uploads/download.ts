import type { Env } from "../../types"
import { badRequest, forward, json, readJson } from "../../lib/do"
import { hashAccessProof } from "../../../shared/crypto"
import { isValidObjectKey, isValidRoomId } from "../../../shared/constants"
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

  const accessProofHash = await hashAccessProof(body.accessProof)
  const vr = await forward(env, body.roomId, "validate", {
    roomId: body.roomId,
    accessProofHash,
  })
  const v = (await vr.json()) as ValidateInviteResponse
  if (v.status === "invalid" || v.status === "deleted") return json({ error: v.status }, 403)

  const obj = await env.MEDIA.get(body.objectKey)
  if (!obj) return json({ error: "not found" }, 404)
  return new Response(obj.body, {
    headers: {
      "content-type": "application/octet-stream",
      "cache-control": "no-store",
      "content-length": String(obj.size),
    },
  })
}
