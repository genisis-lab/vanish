import type { Env } from "../types"
import { roomStub } from "../lib/do"

// GET /api/ws?room=<roomId> — upgrade to a WebSocket and hand the connection to
// the room's Durable Object. The access/participant proofs travel in the
// WebSocket subprotocol (the Sec-WebSocket-Protocol header), which is copied
// through to the DO below; the DO verifies them before accepting the socket.
export const onRequest: PagesFunction<Env> = async ({ request, env }) => {
  const upgrade = request.headers.get("Upgrade") || ""
  if (upgrade.toLowerCase() !== "websocket") {
    return new Response("expected websocket", { status: 426 })
  }

  const url = new URL(request.url)
  const roomId = url.searchParams.get("room") || ""
  if (!roomId) return new Response("missing room", { status: 400 })

  const stub = roomStub(env, roomId)
  // Use a synthetic internal URL for the DO fetch. The host is irrelevant for a
  // Durable Object stub, but building a fresh GET request avoids Pages-specific
  // cloning quirks where the Upgrade/WebSocket handshake can be lost when
  // forwarding `new Request(target, request)` wholesale.
  const target = new URL("https://vanish.do/ws")
  target.search = url.search

  return stub.fetch(
    new Request(target.toString(), {
      method: "GET",
      headers: new Headers(request.headers),
    }),
  )
}
