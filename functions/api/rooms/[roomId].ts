import type { Env } from "../../types"
import { badRequest, forward } from "../../lib/do"

// DELETE /api/rooms/:roomId — destroy the room and all encrypted server data.
// Requires proof-of-possession of the invite secret.
export const onRequestDelete: PagesFunction<Env> = async ({ request, env, params }) => {
  const roomId = String(params.roomId || "")
  if (!roomId) return badRequest("missing roomId")
  let accessProof = ""
  try {
    const body = (await request.json()) as { accessProof?: string }
    accessProof = body?.accessProof || ""
  } catch {
    accessProof = new URL(request.url).searchParams.get("p") || ""
  }
  return forward(env, roomId, "delete", { accessProof })
}
