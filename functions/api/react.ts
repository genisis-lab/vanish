import type { Env } from "../types"
import { badRequest, forward, readJson } from "../lib/do"
import type { ReactRequest } from "../../shared/types"

// POST /api/react — set or clear an encrypted reaction envelope on a message.
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const body = await readJson<ReactRequest>(request)
  if (
    !body?.roomId ||
    !body?.accessProof ||
    !body?.participantProof ||
    !body?.messageId ||
    !body?.reactionId
  ) {
    return badRequest("missing fields")
  }
  return forward(env, body.roomId, "react", body)
}
