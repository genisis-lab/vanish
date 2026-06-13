import type { Env } from "../types"
import { badRequest, forward, readJson } from "../lib/do"
import type { PruneRequest } from "../../shared/types"

// POST /api/prune — remove selected messages or all visible messages.
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const body = await readJson<PruneRequest>(request)
  if (!body?.roomId || !body?.accessProof) return badRequest("missing roomId/accessProof")
  if (body.all && !body.ownerProof) return badRequest("missing ownerProof")
  if (!body.all && (!body.participantId || !body.participantProof)) {
    return badRequest("missing participantId/participantProof")
  }
  if (!body.all && (!body.messageIds || body.messageIds.length === 0)) {
    return badRequest("nothing to prune")
  }
  return forward(env, body.roomId, "prune", body)
}
