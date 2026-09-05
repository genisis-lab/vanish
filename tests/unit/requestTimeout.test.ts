import { afterEach, describe, expect, it, vi } from "vitest"
import { api, requestJson, REQUEST_TIMEOUT_MS } from "../../src/lib/api"
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe("bounded requests", () => {
  it("preserves a helpful rate limit error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "rate limited" }), { status: 429 })),
    )
    await expect(api.createRoom({} as never)).rejects.toThrow("wait a moment")
  })
  it("ends a stalled request with an actionable timeout", async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_path, init) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener("abort", () => reject(init.signal.reason))
          }),
      ),
    )
    const result = expect(requestJson("/test")).rejects.toThrow("timed out")
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS)
    await result
  })
  it("cancels an in-flight upload-signing request without misreporting a network failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_path, init) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener("abort", () => reject(init.signal.reason))
          }),
      ),
    )
    const controller = new AbortController()
    const result = expect(api.signUpload({} as never, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    })
    controller.abort()
    await result
  })
})

it("aborts the actual XHR transfer when an upload is cancelled", async () => {
  let xhr: FakeXhr
  class FakeXhr {
    onabort?: () => void
    onloadend?: () => void
    upload = {}
    open = vi.fn()
    setRequestHeader = vi.fn()
    send = vi.fn()
    abort = vi.fn(() => { this.onabort?.(); this.onloadend?.() })
    constructor() { xhr = this }
  }
  vi.stubGlobal("XMLHttpRequest", FakeXhr)
  const controller = new AbortController()
  const promise = api.uploadBlob({ uploadUrl: "/upload", token: "token", objectKey: "key", size: 2, expiresAt: 1000 } as never, new Uint8Array(2), undefined, controller.signal)
  const rejection = expect(promise).rejects.toMatchObject({ name: "AbortError" })
  controller.abort()
  await rejection
  expect(xhr!.abort).toHaveBeenCalledOnce()
})
