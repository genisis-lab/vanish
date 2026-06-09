// Companion Worker entry. Exports the Durable Object class so Pages can bind to
// it via `script_name`. The default fetch handler is a thin router used mainly
// for health checks and direct (non-Pages) access during local development.

import { isValidRoomId } from "../../shared/constants"
import { RoomDurableObject, type RoomEnv } from "./RoomDurableObject"

export { RoomDurableObject }

export interface Env extends RoomEnv {
  ROOM: DurableObjectNamespace
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ ok: true, service: "vanish-room" }), {
        headers: { "content-type": "application/json" },
      })
    }
    // /room/<roomId>/<op> -> forward to the matching Durable Object.
    const match = url.pathname.match(/^\/room\/([^/]+)\/(.+)$/)
    if (match) {
      const [, roomId, op] = match
      if (!isValidRoomId(roomId)) return new Response("not found", { status: 404 })
      const id = env.ROOM.idFromName(roomId)
      const stub = env.ROOM.get(id)
      const target = new URL(request.url)
      target.pathname = `/${op}`
      return stub.fetch(new Request(target.toString(), request))
    }
    return new Response("not found", { status: 404 })
  },
}
