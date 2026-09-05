// @vitest-environment happy-dom
import { createElement, act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Composer } from "../../src/components/Composer"

let root: Root
let host: HTMLDivElement
const stopTrack = vi.fn()
class Recorder {
  static isTypeSupported() {
    return true
  }
  state = "inactive"
  mimeType = "audio/webm"
  ondataavailable?: (event: { data: Blob }) => void
  onstop?: () => void
  start() {
    this.state = "recording"
  }
  stop() {
    this.state = "inactive"
    this.ondataavailable?.({ data: new Blob(["audio"], { type: this.mimeType }) })
    this.onstop?.()
  }
}
async function click(label: string) {
  const button = [...host.querySelectorAll("button")].find(
    (el) => el.getAttribute("aria-label") === label || el.textContent?.trim() === label,
  )
  expect(button, label).toBeTruthy()
  await act(async () => {
    button!.click()
  })
}
function props() {
  return {
    uploads: [],
    roomId: "test-room",
    defaultTtlMs: 300_000,
    defaultBurn: false,
    replyTo: null,
    onCancelReply: vi.fn(),
    onSend: vi.fn(),
    onSendMedia: vi.fn(),
    onTyping: vi.fn(),
    onCancelUpload: vi.fn(),
  }
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  vi.stubGlobal("MediaRecorder", Recorder)
  vi.stubGlobal("navigator", {
    mediaDevices: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: stopTrack }] })) },
  })
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test-preview")
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {})
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  stopTrack.mockClear()
})

describe("voice-note review", () => {
  it("stopping creates a playable local preview without sending; Send transmits it once", async () => {
    const p = props()
    await act(async () => root.render(createElement(Composer, p)))
    await click("Record an encrypted voice note")
    await click("Stop & preview")
    expect(p.onSendMedia).not.toHaveBeenCalled()
    expect(host.querySelector('audio[aria-label="Voice note preview"]')).not.toBeNull()
    expect(stopTrack).toHaveBeenCalled()
    await click("Send voice note")
    expect(p.onSendMedia).toHaveBeenCalledOnce()
    expect(p.onSendMedia.mock.calls[0][0][0]).toBeInstanceOf(File)
    expect(host.querySelector("audio")).toBeNull()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:test-preview")
  })
  it("discarding a preview releases its URL and sends nothing", async () => {
    const p = props()
    await act(async () => root.render(createElement(Composer, p)))
    await click("Record an encrypted voice note")
    await click("Stop & preview")
    await click("Discard voice note")
    expect(p.onSendMedia).not.toHaveBeenCalled()
    expect(host.querySelector("audio")).toBeNull()
    expect(URL.revokeObjectURL).toHaveBeenCalled()
  })
  it("explains denied microphone permission inline", async () => {
    vi.mocked(navigator.mediaDevices.getUserMedia).mockRejectedValue(
      new DOMException("denied", "NotAllowedError"),
    )
    await act(async () => root.render(createElement(Composer, props())))
    await click("Record an encrypted voice note")
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      "Microphone access was denied",
    )
  })
})
