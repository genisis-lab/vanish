import type { Env } from "../types"
import { badRequest, forward, readJson } from "../lib/do"
import type { CreateRoomRequest } from "../../shared/types"
import { isValidRoomId } from "../../shared/constants"
import { enforceAbuseLimit } from "../lib/abuse"

// POST /api/rooms — register a new room by its access-proof hash. The server
// never sees the invite secret, only SHA-256(accessProof).
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const body = await readJson<CreateRoomRequest>(request)
  if (!body?.roomId || !body?.accessProofHash) return badRequest("missing roomId/accessProofHash")
  if (!isValidRoomId(body.roomId)) return badRequest("bad room id")
  const limited = await enforceAbuseLimit(env, request, "room-create")
  if (limited) return limited
  return forward(env, body.roomId, "create", body)
}
