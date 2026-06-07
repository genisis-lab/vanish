import type { Env } from "../../types"
import { badRequest, forward, readJson } from "../../lib/do"
import type { OwnerActionRequest } from "../../../shared/types"

// POST /api/rooms/owner — owner-gated moderation: ban / unban / clear / destroy.
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const body = await readJson<OwnerActionRequest>(request)
  if (!body?.roomId || !body?.accessProof) return badRequest("missing roomId/accessProof")
  if (!body.ownerProof || !body.action) return badRequest("missing ownerProof/action")
  return forward(env, body.roomId, "owner-action", body)
}
