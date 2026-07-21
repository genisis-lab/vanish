import type { Env } from "../types"
import { badRequest, forward, readJson } from "../lib/do"
import type { SessionRequest } from "../../shared/types"
import { enforceAbuseLimit } from "../lib/abuse"

// POST /api/session — register/refresh a participant's presence in a room.
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const body = await readJson<SessionRequest>(request)
  if (!body?.roomId || !body?.accessProof || !body?.participantId || !body?.participantProof) {
    return badRequest("missing roomId/accessProof/participantId/participantProof")
  }
  const limited = await enforceAbuseLimit(env, request, "session-register")
  if (limited) return limited
  return forward(env, body.roomId, "session", body)
}
