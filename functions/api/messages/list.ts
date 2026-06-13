import type { Env } from "../../types"
import { badRequest, forward, readJson } from "../../lib/do"
import type { ListMessagesRequest } from "../../../shared/types"

// POST /api/messages/list — fetch encrypted messages (polling fallback + initial load).
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const body = await readJson<ListMessagesRequest>(request)
  if (!body?.roomId || !body?.accessProof || !body?.participantId || !body?.participantProof) {
    return badRequest("missing roomId/accessProof/participantId/participantProof")
  }
  return forward(env, body.roomId, "list", body)
}
