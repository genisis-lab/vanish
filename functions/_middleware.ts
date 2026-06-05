// Defense-in-depth headers applied to every Functions response (the static
// _headers file covers asset responses; this covers API responses).
import type { Env } from "./types"

export const onRequest: PagesFunction<Env> = async ({ next }) => {
  const res = await next()
  const headers = new Headers(res.headers)
  headers.set("X-Content-Type-Options", "nosniff")
  headers.set("Referrer-Policy", "no-referrer")
  headers.set("X-Frame-Options", "DENY")
  if (!headers.has("cache-control")) headers.set("cache-control", "no-store")
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
}
