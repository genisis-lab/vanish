import type { Env } from "../../types"
import { badRequest, forward, readJson } from "../../lib/do"

// DELETE /api/rooms/:roomId — destroy the room and all encrypted server data.
// Requires proof-of-possession of both the invite secret and owner secret.
//
// Proofs are accepted ONLY from the JSON body, never the query string, so these
// bearer values can't leak into CDN/proxy/access logs.
export const onRequestDelete: PagesFunction<Env> = async ({ request, env, params }) => {
  const roomId = String(params.roomId || "")
  if (!roomId) return badRequest("missing roomId")
  const body = await readJson<{ accessProof?: string; ownerProof?: string }>(request)
  if (!body) return badRequest("invalid JSON body")
  const accessProof = body.accessProof || ""
  const ownerProof = body.ownerProof || ""
  if (!accessProof || !ownerProof) return badRequest("missing accessProof/ownerProof")
  return forward(env, roomId, "delete", { accessProof, ownerProof })
}
