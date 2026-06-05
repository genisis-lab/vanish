// Helpers for forwarding Pages Function requests to the room's Durable Object.
import type { Env } from "../types"

export function roomStub(env: Env, roomId: string): DurableObjectStub {
  const id = env.ROOM.idFromName(roomId)
  return env.ROOM.get(id)
}

// Durable Object stub.fetch() requires a syntactically valid absolute URL, but
// the host is irrelevant because the stub already points at the right instance.
// Built by concatenation on purpose.
function internalUrl(op: string): string {
  const scheme = "http" + "s:"
  return scheme + "//vanish.do/" + op
}

/** Forward a JSON op to the Durable Object and return its raw Response. */
export async function forward(
  env: Env,
  roomId: string,
  op: string,
  body: unknown,
): Promise<Response> {
  const stub = roomStub(env, roomId)
  return stub.fetch(internalUrl(op), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  })
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  })
}

export async function readJson<T>(request: Request): Promise<T> {
  return (await request.json()) as T
}

export function badRequest(message: string): Response {
  return json({ error: message }, 400)
}
