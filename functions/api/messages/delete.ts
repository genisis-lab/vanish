import type { Env } from "../../types"
import { badRequest, forward, readJson } from "../../lib/do"
import type { DeleteOwnMessageRequest } from "../../../shared/types"

// POST /api/messages/delete — soft-delete (tombstone) your own message for everyone.
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const body = await readJson<DeleteOwnMessageRequest>(request)
  if (!body?.roomId || !body?.accessProof) return badRequest("missing roomId/accessProof")
  if (!body.messageId || !body.participantId) return badRequest("missing fields")
  return forward(env, body.roomId, "delete-message", body)
}
