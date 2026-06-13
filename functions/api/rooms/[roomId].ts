import type { Env } from "../../types"
import { badRequest, forward } from "../../lib/do"

// DELETE /api/rooms/:roomId — destroy the room and all encrypted server data.
// Requires proof-of-possession of both the invite secret and owner secret.
export const onRequestDelete: PagesFunction<Env> = async ({ request, env, params }) => {
  const roomId = String(params.roomId || "")
  if (!roomId) return badRequest("missing roomId")
  let accessProof = ""
  let ownerProof = ""
  try {
    const body = (await request.json()) as { accessProof?: string; ownerProof?: string }
    accessProof = body?.accessProof || ""
    ownerProof = body?.ownerProof || ""
  } catch {
    accessProof = new URL(request.url).searchParams.get("p") || ""
    ownerProof = new URL(request.url).searchParams.get("op") || ""
  }
  if (!accessProof || !ownerProof) return badRequest("missing accessProof/ownerProof")
  return forward(env, roomId, "delete", { accessProof, ownerProof })
}
