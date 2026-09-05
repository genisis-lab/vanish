// @vitest-environment happy-dom
import { createElement, StrictMode, act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { ReadOnceViewer } from "../../src/components/ReadOnceViewer"
import { api } from "../../src/lib/api"
import { decryptToObjectUrl, revokeMediaObject } from "../../src/lib/media"
import type { RoomSession } from "../../src/lib/session"
import type { DecryptedMessage } from "../../src/lib/messages"
vi.mock("../../src/lib/api", () => ({ api: { consumeMessages: vi.fn() } }))
vi.mock("../../src/lib/media", () => ({ decryptToObjectUrl: vi.fn(), requiresStreamingSave: () => false, revokeMediaObject: vi.fn(), saveLargeMediaToFile: vi.fn() }))
let host: HTMLDivElement, root: Root
const session = { invite: { roomId: "room" }, keys: { accessProof: "proof" }, participantId: "bob", participantProof: "bob-proof" } as RoomSession
const message = (): DecryptedMessage => ({ id: "once", participantId: "alice", username: "Alice", kind: "media", text: "Caption", mine: false, burn: true, createdAt: Date.now(), expiresAt: Date.now() + 30_000, reactions: [], items: [{ objectKey: "image", filename: "test.png", mime: "image/png", size: 50, previewKind: "image" }] })
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  vi.mocked(api.consumeMessages).mockResolvedValue({ consumedIds: ["once"] })
  host = document.createElement("div"); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.clearAllMocks(); vi.unstubAllGlobals() })
it("loads media before consumption and sends only one receipt under StrictMode", async () => {
  let loaded!: (url: string) => void
  const download = new Promise<string>((resolve) => { loaded = resolve })
  vi.mocked(decryptToObjectUrl).mockReturnValue(download)
  await act(async () => root.render(createElement(StrictMode, null, createElement(ReadOnceViewer, { session, message: message(), onClose: vi.fn() }))))
  expect(api.consumeMessages).not.toHaveBeenCalled()
  await act(async () => loaded("blob:loaded-image"))
  expect(api.consumeMessages).toHaveBeenCalledOnce()
  expect(document.querySelector('img[alt="test.png"]')?.getAttribute("src")).toBe("blob:loaded-image")
  await act(async () => root.unmount())
  expect(revokeMediaObject).toHaveBeenCalledWith("image")
  root = createRoot(host)
})
it("does not consume an attachment when decryption fails", async () => {
  vi.mocked(decryptToObjectUrl).mockRejectedValue(new Error("Could not decrypt attachment"))
  await act(async () => root.render(createElement(ReadOnceViewer, { session, message: message(), onClose: vi.fn() })))
  expect(api.consumeMessages).not.toHaveBeenCalled()
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("Could not decrypt")
})
it("does not reveal content when another recipient already consumed it", async () => {
  vi.mocked(decryptToObjectUrl).mockResolvedValue("blob:loaded-image")
  vi.mocked(api.consumeMessages).mockResolvedValue({ consumedIds: [] })
  await act(async () => root.render(createElement(ReadOnceViewer, { session, message: message(), onClose: vi.fn() })))
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("already opened")
  expect(document.querySelector("img")).toBeNull()
})
