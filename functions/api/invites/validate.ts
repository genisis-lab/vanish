import type { Env } from "../../types"
import { badRequest, forward, json, readJson } from "../../lib/do"
import type { ValidateInviteRequest, ValidateInviteResponse } from "../../../shared/types"

// POST /api/invites/validate — check a room using only roomId + accessProofHash.
// The raw secret/proof never leaves the client for this call.
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const body = await readJson<ValidateInviteRequest>(request)
  if (!body?.roomId || !body?.accessProofHash) return badRequest("missing roomId/accessProofHash")
  const res = await forward(env, body.roomId, "validate", body)
  if (!res.ok) return res
  // Collapse "deleted" into "invalid" so this endpoint can't be used to
  // distinguish a room that once existed (then was deleted) from one that never
  // existed — both are indistinguishable to anyone probing with only a roomId.
  const data = (await res.json()) as ValidateInviteResponse
  if (data.status === "deleted") data.status = "invalid"
  return json(data)
}
