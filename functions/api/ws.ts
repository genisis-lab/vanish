import type { Env } from "../types"
import { roomStub } from "../lib/do"

// GET /api/ws?room=<roomId>&p=<accessProof>&u=<participantId> — upgrade to a
// WebSocket and hand the connection to the room's Durable Object. The DO
// verifies the access proof before accepting the socket.
export const onRequest: PagesFunction<Env> = async ({ request, env }) => {
  if (request.headers.get("Upgrade") !== "websocket") {
    return new Response("expected websocket", { status: 426 })
  }
  const url = new URL(request.url)
  const roomId = url.searchParams.get("room") || ""
  if (!roomId) return new Response("missing room", { status: 400 })

  const stub = roomStub(env, roomId)
  const target = new URL(request.url)
  target.pathname = "/ws"
  return stub.fetch(new Request(target.toString(), request))
}
