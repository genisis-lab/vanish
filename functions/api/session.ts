import type { Env } from "../types"
import { badRequest, forward, readJson } from "../lib/do"
import type { SessionRequest } from "../../shared/types"

// POST /api/session — register/refresh a participant's presence in a room.
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const body = await readJson<SessionRequest>(request)
  if (!body?.roomId || !body?.accessProof || !body?.participantId || !body?.participantProof) {
    return badRequest("missing roomId/accessProof/participantId/participantProof")
  }
  const clientIp =
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    undefined
  return forward(env, body.roomId, "session", { ...body, clientIp })
}
