// Helpers for forwarding Pages Function requests to the room's Durable Object.
import type { Env } from "../types"
import { isValidRoomId, MAX_JSON_BODY_BYTES } from "../../shared/constants"

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
  if (!isValidRoomId(roomId)) return badRequest("bad room id")
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

export async function readJson<T>(
  request: Request,
  maxBytes = MAX_JSON_BODY_BYTES,
): Promise<T | null> {
  const declared = request.headers.get("content-length")
  if (declared !== null) {
    const length = Number(declared)
    if (!Number.isSafeInteger(length) || length < 0 || length > maxBytes) return null
  }
  if (!request.body) return null
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel("request body too large").catch(() => undefined)
        return null
      }
      chunks.push(value)
    }
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as T
  } catch {
    return null
  } finally {
    reader.releaseLock()
  }
}

export function badRequest(message: string): Response {
  return json({ error: message }, 400)
}
