import type { Env } from "../../types"
import { badRequest, forward, readJson } from "../../lib/do"
import type { UpdateInviteRequest } from "../../../shared/types"

// POST /api/invites/update — change invite expiry / default TTL / burn settings.
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const body = await readJson<UpdateInviteRequest>(request)
  if (!body?.roomId || !body?.accessProof) return badRequest("missing roomId/accessProof")
  return forward(env, body.roomId, "update", body)
}
