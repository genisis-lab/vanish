import type { Env } from "../../types"
import { badRequest, forward, readJson } from "../../lib/do"
import type { OwnerQueryRequest } from "../../../shared/types"

// POST /api/rooms/owner-query — owner-gated: return participant IPs and the
// IP ban list. The Durable Object verifies both the access proof and the owner
// proof before returning any data.
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const body = await readJson<OwnerQueryRequest>(request)
  if (!body?.roomId || !body?.accessProof || !body?.ownerProof) {
    return badRequest("missing roomId/accessProof/ownerProof")
  }
  return forward(env, body.roomId, "owner-query", body)
}
