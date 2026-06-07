import type { Env } from "../../types"
import { badRequest, forward, readJson } from "../../lib/do"
import type { SetTopicRequest } from "../../../shared/types"

// POST /api/rooms/topic — owner-gated: set/clear the encrypted room topic.
// The topic envelope is opaque; the server only swaps and rebroadcasts it.
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const body = await readJson<SetTopicRequest>(request)
  if (!body?.roomId || !body?.accessProof) return badRequest("missing roomId/accessProof")
  if (!body.ownerProof) return badRequest("missing ownerProof")
  return forward(env, body.roomId, "set-topic", body)
}
