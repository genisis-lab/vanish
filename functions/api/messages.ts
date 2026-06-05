import type { Env } from "../types"
import { badRequest, forward, readJson } from "../lib/do"
import type { PostMessageRequest } from "../../shared/types"

// POST /api/messages — append an opaque encrypted message envelope.
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const body = await readJson<PostMessageRequest>(request)
  if (!body?.roomId || !body?.accessProof || !body?.message?.id || !body?.message?.envelope) {
    return badRequest("missing message fields")
  }
  return forward(env, body.roomId, "message", body)
}
