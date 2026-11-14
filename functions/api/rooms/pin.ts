import type { Env } from "../../types"
import { badRequest, forward, readJson } from "../../lib/do"
import type { SetPinRequest } from "../../../shared/types"

// POST /api/rooms/pin — owner-gated: pin a message or clear the pin. The pin
// envelope is opaque; the server only stores and rebroadcasts it.
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const body = await readJson<SetPinRequest>(request)
  if (!body?.roomId || !body?.accessProof) return badRequest("missing roomId/accessProof")
  if (!body.ownerProof) return badRequest("missing ownerProof")
  return forward(env, body.roomId, "set-pin", body)
}
