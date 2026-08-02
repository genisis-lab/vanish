import type { Env } from "../../types"
import { badRequest, forward, readJson } from "../../lib/do"
import type { ReportMessageRequest } from "../../../shared/types"

// POST /api/messages/report — verifies room membership in the Durable Object.
// The forwarded body contains identifiers and a category, never message content.
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const body = await readJson<ReportMessageRequest>(request)
  if (
    !body?.roomId ||
    !body.accessProof ||
    !body.participantId ||
    !body.participantProof ||
    !body.messageId ||
    !body.category
  ) return badRequest("missing report fields")
  return forward(env, body.roomId, "report-message", body)
}
