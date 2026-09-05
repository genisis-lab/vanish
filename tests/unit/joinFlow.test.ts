// @vitest-environment happy-dom
import { act, createElement, StrictMode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, expect, it, vi } from "vitest"
import { createUpdateReload } from "../../src/lib/serviceWorkerUpdate"
import { useRoom } from "../../src/lib/useRoom"
import type { RoomSession } from "../../src/lib/session"

const mocks = vi.hoisted(() => ({
  session: vi.fn(), broadcast: vi.fn(), list: vi.fn(), handlers: null as any,
}))
vi.mock("../../src/lib/api", () => ({
  api: { session: mocks.session, broadcast: mocks.broadcast, listMessages: mocks.list },
  ApiError: class extends Error {},
}))
vi.mock("../../src/lib/realtime", () => ({ Realtime: class {
  constructor(_session: unknown, handlers: unknown) { mocks.handlers = handlers }
  start() {} stop() {}
} }))
vi.mock("../../src/lib/vault", () => ({ vault: { get: () => undefined } }))
vi.mock("../../src/lib/notify", () => ({ ensureNotificationPrompt() {}, notificationsEnabled: () => false }))
vi.mock("../../shared/crypto", async (importOriginal) => ({ ...await importOriginal<typeof import("../../shared/crypto")>(), encryptString: async () => "encrypted-join", decryptString: async () => "Guest" }))
let root: Root | undefined
let host: HTMLDivElement | undefined
afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = undefined
  host?.remove()
  vi.useRealTimers()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

it("does not reload a first-time invite visitor or a tab whose update was accepted elsewhere", () => {
  const reload = vi.fn()
  const update = createUpdateReload(reload)
  update.controllerChanged()
  update.controllerChanged()
  expect(reload).not.toHaveBeenCalled()
  update.request()
  update.controllerChanged()
  update.controllerChanged()
  expect(reload).toHaveBeenCalledOnce()
})

it("registers before announcing, retries a rejected join, and displays a named notice only once", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  vi.useFakeTimers()
  let registered!: () => void
  const registration = new Promise<void>((resolve) => { registered = resolve })
  mocks.session.mockReturnValue(registration)
  mocks.broadcast.mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ ok: true })
  mocks.list.mockResolvedValue({ messages: [], room: { participantCount: 1 } })
  const session = { invite: { roomId: "test-room" }, keys: { accessProof: "proof" }, participantId: "self", participantProof: "self-proof", username: "Sender" } as RoomSession
  function Probe() {
    const room = useRoom(session)
    return createElement("div", null, room.messages.map(m => m.text).join("\n"))
  }
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(createElement(StrictMode, null, createElement(Probe))))
  expect(mocks.broadcast).not.toHaveBeenCalled()
  await act(async () => registered())
  expect(mocks.broadcast).toHaveBeenCalledTimes(1)
  expect(mocks.broadcast.mock.calls[0][0].event).toEqual({ type: "join", participantId: "self", envelope: "encrypted-join" })
  await act(async () => { await vi.advanceTimersByTimeAsync(20_000) })
  expect(mocks.broadcast).toHaveBeenCalledTimes(2)
  await act(async () => { await vi.advanceTimersByTimeAsync(20_000) })
  expect(mocks.broadcast).toHaveBeenCalledTimes(2)
  const event = { t: "signal", event: { type: "join", participantId: "guest", envelope: "guest-envelope" } }
  await act(async () => { mocks.handlers.onSignal(event); mocks.handlers.onSignal(event) })
  expect(host.textContent).toBe("Guest joined the room")
})
