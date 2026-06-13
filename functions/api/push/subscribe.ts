import type { Env } from "../../types"
import { badRequest, forward, readJson } from "../../lib/do"
import type { PushSubscribeRequest } from "../../../shared/types"

// POST /api/push/subscribe — register this browser's Web Push subscription for
// the room so it can be woken even when the app is fully closed.
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const body = await readJson<PushSubscribeRequest>(request)
  if (
    !body?.roomId ||
    !body?.accessProof ||
    !body?.participantId ||
    !body?.participantProof ||
    !body?.subscription?.endpoint
  ) {
    return badRequest("missing push subscription fields")
  }
  return forward(env, body.roomId, "push-subscribe", body)
}
