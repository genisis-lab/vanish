import type { Env } from "../../types"
import { badRequest, forward, readJson } from "../../lib/do"
import type { SetTimerRequest } from "../../../shared/types"

// POST /api/rooms/timer — any member: change the room's disappearing-message
// timer for everyone, with an optional encrypted system notice.
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const body = await readJson<SetTimerRequest>(request)
  if (!body?.roomId || !body?.accessProof) return badRequest("missing roomId/accessProof")
  if (!body.participantId || !body.participantProof) {
    return badRequest("missing participantId/participantProof")
  }
  return forward(env, body.roomId, "set-timer", body)
}
