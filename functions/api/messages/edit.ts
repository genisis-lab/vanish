import type { Env } from "../../types"
import { badRequest, forward, readJson } from "../../lib/do"
import type { EditMessageRequest } from "../../../shared/types"

// POST /api/messages/edit — replace your own message's encrypted envelope.
// The new envelope is opaque (re-signed in the browser); the server just swaps it.
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const body = await readJson<EditMessageRequest>(request)
  if (!body?.roomId || !body?.accessProof) return badRequest("missing roomId/accessProof")
  if (!body.messageId || !body.participantId || !body.envelope) return badRequest("missing fields")
  return forward(env, body.roomId, "edit", body)
}
