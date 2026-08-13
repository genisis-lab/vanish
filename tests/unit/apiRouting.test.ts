import { describe, expect, it, vi } from "vitest"
import { routeApiRequest } from "../../functions/api/_middleware"

function route(pathname: string, method = "GET", next = vi.fn(async () => new Response("ok"))) {
  return {
    next,
    response: routeApiRequest(
      new Request(`https://chat.builtwai.com${pathname}`, { method }),
      next,
    ),
  }
}

describe("API routing middleware", () => {
  it.each([
    ["/api/rooms", "POST"],
    ["/api/push/vapid", "GET"],
    ["/api/ws", "GET"],
    ["/api/rooms/example-room", "DELETE"],
  ])("passes through valid %s %s requests", async (pathname, method) => {
    const { next, response } = route(pathname, method)

    expect((await response).status).toBe(200)
    expect(next).toHaveBeenCalledOnce()
  })

  it("returns 405 and Allow for known routes without calling the handler", async () => {
    const { next, response } = route("/api/rooms")
    const result = await response

    expect(result.status).toBe(405)
    expect(result.headers.get("allow")).toBe("POST")
    expect(next).not.toHaveBeenCalled()
    expect(await result.json()).toEqual({ error: "Method not allowed" })
  })

  it("checks static routes before the dynamic room route", async () => {
    const { next, response } = route("/api/rooms/owner", "DELETE")

    expect((await response).headers.get("allow")).toBe("POST")
    expect(next).not.toHaveBeenCalled()
  })

  it("normalizes trailing slashes on dynamic routes", async () => {
    const { next, response } = route("/api/rooms/example-room/")

    expect((await response).headers.get("allow")).toBe("DELETE")
    expect(next).not.toHaveBeenCalled()
  })

  it("returns a hardened JSON 404 for unknown API paths", async () => {
    const { next, response } = route("/api/not-a-route/deeper")
    const result = await response

    expect(result.status).toBe(404)
    expect(result.headers.has("allow")).toBe(false)
    expect(result.headers.get("content-type")).toBe("application/json; charset=utf-8")
    expect(result.headers.get("cache-control")).toBe("no-store")
    expect(result.headers.get("x-content-type-options")).toBe("nosniff")
    expect(next).not.toHaveBeenCalled()
    expect(await result.json()).toEqual({ error: "Not found" })
  })
})
