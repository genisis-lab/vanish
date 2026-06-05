import type { Env } from "../types"
import { badRequest, forward, readJson } from "../lib/do"
import type { SessionRequest } from "../../shared/types"

// POST /api/session — register/refresh a participant's presence in a room.
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const body = await readJson<SessionRequest>(request)
  if (!body?.roomId || !body?.accessProof || !body?.participantId) {
    return badRequest("missing roomId/accessProof/participantId")
  }
  return forward(env, body.roomId, "session", body)
}
