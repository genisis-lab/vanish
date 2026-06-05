import type { Env } from "../types"
import { badRequest, forward, readJson } from "../lib/do"
import type { CreateRoomRequest } from "../../shared/types"

// POST /api/rooms — register a new room by its access-proof hash. The server
// never sees the invite secret, only SHA-256(accessProof).
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const body = await readJson<CreateRoomRequest>(request)
  if (!body?.roomId || !body?.accessProofHash) return badRequest("missing roomId/accessProofHash")
  return forward(env, body.roomId, "create", body)
}
