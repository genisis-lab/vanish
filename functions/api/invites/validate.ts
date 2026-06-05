import type { Env } from "../../types"
import { badRequest, forward, readJson } from "../../lib/do"
import type { ValidateInviteRequest } from "../../../shared/types"

// POST /api/invites/validate — check a room using only roomId + accessProofHash.
// The raw secret/proof never leaves the client for this call.
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const body = await readJson<ValidateInviteRequest>(request)
  if (!body?.roomId || !body?.accessProofHash) return badRequest("missing roomId/accessProofHash")
  return forward(env, body.roomId, "validate", body)
}
