// Companion Worker entry. Exports the Durable Object class so Pages can bind to
// it via `script_name`. The default fetch handler exposes only a health check;
// room operations must cross the validated Pages service-binding boundary.

import { RoomDurableObject, type RoomEnv } from "./RoomDurableObject"
import { AbuseDurableObject } from "./AbuseDurableObject"

export { AbuseDurableObject, RoomDurableObject }

export interface Env extends RoomEnv {
  ROOM: DurableObjectNamespace
  ABUSE: DurableObjectNamespace
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ ok: true, service: "vanish-room" }), {
        headers: { "content-type": "application/json" },
      })
    }
    // Room operations are intentionally not routed through this public fetch
    // handler. Pages reaches the namespaces through service bindings, preserving
    // validation and rate limits at the only supported external boundary.
    void env
    return new Response("not found", { status: 404 })
  },
}
