import type { Env } from "../types"
import { badRequest, forward, readJson } from "../lib/do"
import type { BroadcastRequest } from "../../shared/types"

// POST /api/broadcast — relay an opaque signalling envelope (typing/seen) to peers.
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const body = await readJson<BroadcastRequest>(request)
  if (
    !body?.roomId ||
    !body?.accessProof ||
    !body?.participantId ||
    !body?.participantProof ||
    !body?.event
  ) {
    return badRequest("missing fields")
  }
  return forward(env, body.roomId, "broadcast", body)
}
