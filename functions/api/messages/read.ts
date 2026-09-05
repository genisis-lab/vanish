import type { Env } from "../../types"
import { badRequest, forward, readJson } from "../../lib/do"
import type { ReadReceiptRequest } from "../../../shared/types"
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const body = await readJson<ReadReceiptRequest>(request)
  if (!body?.roomId || !body.accessProof || !body.participantId || !body.participantProof)
    return badRequest("missing credentials")
  return forward(env, body.roomId, "read", body)
}
