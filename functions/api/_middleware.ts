import type { Env } from "../types"

const EXACT_ROUTE_METHODS = new Map<string, string>([
  ["/api/broadcast", "POST"],
  ["/api/invites/update", "POST"],
  ["/api/invites/validate", "POST"],
  ["/api/messages", "POST"],
  ["/api/messages/delete", "POST"],
  ["/api/messages/edit", "POST"],
  ["/api/messages/list", "POST"],
  ["/api/messages/report", "POST"],
  ["/api/prune", "POST"],
  ["/api/push/subscribe", "POST"],
  ["/api/push/unsubscribe", "POST"],
  ["/api/push/vapid", "GET"],
  ["/api/react", "POST"],
  ["/api/rooms", "POST"],
  ["/api/rooms/owner", "POST"],
  ["/api/rooms/topic", "POST"],
  ["/api/session", "POST"],
  ["/api/uploads/download", "POST"],
  ["/api/uploads/multipart/abort", "DELETE"],
  ["/api/uploads/multipart/complete", "POST"],
  ["/api/uploads/multipart/create", "POST"],
  ["/api/uploads/multipart/part", "PUT"],
  ["/api/uploads/put", "POST"],
  ["/api/uploads/sign", "POST"],
  ["/api/ws", "GET"],
])

function normalizedPathname(url: string): string {
  const pathname = new URL(url).pathname
  return pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname
}

function allowedMethod(pathname: string): string | undefined {
  const exact = EXACT_ROUTE_METHODS.get(pathname)
  if (exact) return exact
  if (/^\/api\/rooms\/[^/]+$/.test(pathname)) return "DELETE"
  return undefined
}

function jsonError(message: string, status: number, allow?: string): Response {
  const headers = new Headers({
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'; sandbox",
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  })
  if (allow) headers.set("allow", allow)
  return new Response(JSON.stringify({ error: message }), { status, headers })
}

export async function routeApiRequest(
  request: Request,
  next: () => Promise<Response>,
): Promise<Response> {
  const allow = allowedMethod(normalizedPathname(request.url))
  if (!allow) return jsonError("Not found", 404)
  if (request.method !== allow) return jsonError("Method not allowed", 405, allow)
  return next()
}

export const onRequest: PagesFunction<Env> = async ({ request, next }) =>
  routeApiRequest(request, next)
