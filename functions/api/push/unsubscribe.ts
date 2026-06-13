import type { Env } from "../../types"
import { badRequest, forward, readJson } from "../../lib/do"
import type { PushUnsubscribeRequest } from "../../../shared/types"

// POST /api/push/unsubscribe — stop pushing to this endpoint for the room.
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const body = await readJson<PushUnsubscribeRequest>(request)
  if (
    !body?.roomId ||
    !body?.accessProof ||
    !body?.participantId ||
    !body?.participantProof ||
    !body?.endpoint
  ) {
    return badRequest("missing push unsubscribe fields")
  }
  return forward(env, body.roomId, "push-unsubscribe", body)
}
