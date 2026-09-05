import type { Env } from "../../types"
import { badRequest, forward, readJson } from "../../lib/do"
import type { ConsumeMessagesRequest } from "../../../shared/types"

// Receipt sent only after the recipient explicitly opens and loads read-once content.
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const body = await readJson<ConsumeMessagesRequest>(request)
  if (!body?.roomId || !body.accessProof || !body.participantId || !body.participantProof) {
    return badRequest("missing room or participant credentials")
  }
  return forward(env, body.roomId, "consume", body)
}
