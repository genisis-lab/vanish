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
    onChangeTimer: vi.fn(async () => {}),
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

describe("disappearing timer", () => {
  const timerSelect = () =>
    host.querySelector<HTMLSelectElement>('select[aria-label="Disappearing timer"]')!
  const selectedLabel = () => timerSelect().selectedOptions[0]?.textContent
  async function chooseTimer(label: string) {
    const select = timerSelect()
    const option = [...select.options].find((o) => o.textContent === label)
    expect(option, label).toBeTruthy()
    await act(async () => {
      select.value = option!.value
      select.dispatchEvent(new Event("change", { bubbles: true }))
    })
  }

  it("shows the chat's timer and changes it for everyone instead of per message", async () => {
    const p = props()
    await act(async () => root.render(createElement(Composer, p)))
    expect(selectedLabel()).toBe("5m")
    await chooseTimer("Never")
    expect(p.onChangeTimer).toHaveBeenCalledWith(0)
    await click("Record an encrypted voice note")
    await click("Stop & preview")
    await click("Send voice note")
    expect(p.onSendMedia.mock.calls[0][2].ttlMs).toBeUndefined()
  })

  it("follows a timer change made by someone else", async () => {
    const p = props()
    await act(async () => root.render(createElement(Composer, p)))
    await act(async () => root.render(createElement(Composer, { ...p, defaultTtlMs: 0 })))
    expect(selectedLabel()).toBe("Never")
  })

  it("does nothing when the current timer is picked again", async () => {
    const p = props()
    await act(async () => root.render(createElement(Composer, p)))
    await chooseTimer("5m")
    expect(p.onChangeTimer).not.toHaveBeenCalled()
  })

  it("still shows a room timer that is not in the list", async () => {
    await act(async () =>
      root.render(createElement(Composer, { ...props(), defaultTtlMs: 2 * 3_600_000 })),
    )
    expect(selectedLabel()).toBe("2h")
    expect([...timerSelect().options].map((o) => o.textContent).at(-1)).toBe("Never")
  })
})

describe("switching to Never with messages already here", () => {
  const timerSelect = () =>
    host.querySelector<HTMLSelectElement>('select[aria-label="Disappearing timer"]')!
  async function render(keepableCount: number) {
    const p = { ...props(), keepableCount }
    await act(async () => root.render(createElement(Composer, p)))
    return p
  }
  async function chooseNever() {
    const select = timerSelect()
    await act(async () => {
      select.value = "0"
      select.dispatchEvent(new Event("change", { bubbles: true }))
    })
  }

  it("asks whether to keep them, and keeps them on request", async () => {
    const p = await render(3)
    await chooseNever()
    expect(p.onChangeTimer).not.toHaveBeenCalled()
    expect(host.textContent).toContain("Also keep the 3 messages already here?")
    await click("Keep them too")
    expect(p.onChangeTimer).toHaveBeenCalledWith(0, { keepExisting: true })
  })

  it("can apply Never to new messages only", async () => {
    const p = await render(1)
    await chooseNever()
    expect(host.textContent).toContain("Also keep the 1 message already here?")
    await click("Only new messages")
    expect(p.onChangeTimer).toHaveBeenCalledWith(0)
  })

  it("can be cancelled without changing the timer", async () => {
    const p = await render(2)
    await chooseNever()
    await click("Cancel")
    expect(p.onChangeTimer).not.toHaveBeenCalled()
    expect(timerSelect().selectedOptions[0]?.textContent).toBe("5m")
    expect(host.textContent).not.toContain("already here?")
  })

  it("doesn't ask when nothing is counting down", async () => {
    const p = await render(0)
    await chooseNever()
    expect(p.onChangeTimer).toHaveBeenCalledWith(0)
  })
})

describe("locked timer", () => {
  it("is read-only for members when the owner locks it", async () => {
    await act(async () => root.render(createElement(Composer, { ...props(), timerLocked: true })))
    const select = host.querySelector<HTMLSelectElement>('select[aria-label="Disappearing timer"]')!
    expect(select.disabled).toBe(true)
    expect(select.title).toBe("Only the room owner can change the timer")
  })
})

describe("keeping older messages once the timer is already Never", () => {
  it("offers to keep messages still counting down", async () => {
    const p = { ...props(), defaultTtlMs: 0, keepableCount: 4 }
    await act(async () => root.render(createElement(Composer, p)))
    await click("Keep 4 older")
    expect(host.textContent).toContain("Keep the 4 older messages that are still counting down?")
    await click("Keep them")
    expect(p.onChangeTimer).toHaveBeenCalledWith(0, { keepExisting: true })
  })
})

describe("editing, shortcuts and mentions", () => {
  const editor = () => host.querySelector<HTMLDivElement>('[role="textbox"]')!
  const button = (label: string) =>
    [...host.querySelectorAll("button")].find((el) => el.getAttribute("aria-label") === label)
  const options = () =>
    [...host.querySelectorAll('[role="option"]')].map((el) => el.textContent)
  // Put text in the box with the caret at its end, as typing would.
  async function type(text: string) {
    await act(async () => {
      const el = editor()
      el.textContent = text
      const node = el.firstChild ?? el
      const range = document.createRange()
      range.setStart(node, text.length)
      range.collapse(true)
      const sel = window.getSelection()!
      sel.removeAllRanges()
      sel.addRange(range)
      el.dispatchEvent(new Event("input", { bubbles: true }))
    })
  }
  async function key(name: string) {
    await act(async () => {
      editor().dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true }))
    })
  }

  it("saves an edit instead of sending, then puts the draft back", async () => {
    const p = { ...props(), onSaveEdit: vi.fn(), onCancelEdit: vi.fn() }
    await act(async () => root.render(createElement(Composer, p)))
    await type("half-typed draft")
    const editing = { id: "m1", text: "old **text**" }
    await act(async () => root.render(createElement(Composer, { ...p, editing })))
    expect(editor().textContent).toBe("old **text**")
    expect(host.querySelector(".edit-bar")?.textContent).toContain("Editing message")
    expect(host.querySelector(".edit-bar")?.textContent).toContain("old text")
    expect(button("Save edit")).toBeTruthy()
    expect(button("Attach encrypted photo or video")).toBeUndefined()
    await type("new text")
    await key("Enter")
    expect(p.onSaveEdit).toHaveBeenCalledWith("new text")
    expect(p.onSend).not.toHaveBeenCalled()
    await act(async () => root.render(createElement(Composer, { ...p, editing: null })))
    expect(editor().textContent).toBe("half-typed draft")
  })

  it("Escape cancels an edit, or else a reply", async () => {
    const p = { ...props(), onCancelEdit: vi.fn() }
    await act(async () =>
      root.render(createElement(Composer, { ...p, editing: { id: "m1", text: "hi" } })),
    )
    await key("Escape")
    expect(p.onCancelEdit).toHaveBeenCalledOnce()
    const replyTo = { id: "m2", username: "Ash", preview: "hello" }
    await act(async () => root.render(createElement(Composer, { ...p, editing: null, replyTo })))
    await key("Escape")
    expect(p.onCancelReply).toHaveBeenCalledOnce()
  })

  it("Up arrow in an empty box edits my latest message", async () => {
    const p = { ...props(), onEditLast: vi.fn(() => true) }
    await act(async () => root.render(createElement(Composer, p)))
    await key("ArrowUp")
    expect(p.onEditLast).toHaveBeenCalledOnce()
    await type("not empty")
    await key("ArrowUp")
    expect(p.onEditLast).toHaveBeenCalledOnce()
  })

  it("suggests names after @ and inserts the chosen one", async () => {
    const p = { ...props(), mentionNames: ["Ben", "Ash K", "Bea"] }
    await act(async () => root.render(createElement(Composer, p)))
    await type("Hi @b")
    expect(options()).toEqual(["@Bea", "@Ben"])
    await key("ArrowDown")
    expect(host.querySelector('[aria-selected="true"]')?.textContent).toBe("@Ben")
    await key("Enter")
    expect(editor().textContent).toBe("Hi @Ben ")
    expect(options()).toEqual([])
    expect(p.onSend).not.toHaveBeenCalled()
    // Names with spaces match as they are typed; Escape closes the list.
    await type("ok @ash ")
    expect(options()).toEqual(["@Ash K"])
    await key("Escape")
    expect(options()).toEqual([])
    // No suggestions inside a word, such as an email address.
    await type("mail me at bea@b")
    expect(options()).toEqual([])
  })

  it("keeps the box editable while an attachment uploads, but waits to send", async () => {
    const uploads = [
      { id: "u1", messageId: "m1", filename: "a.png", status: "uploading" as const, progress: 0.5 },
    ]
    const p = { ...props(), uploads }
    await act(async () => root.render(createElement(Composer, p)))
    expect(editor().getAttribute("contenteditable")).toBe("true")
    await type("next message")
    expect(button("Send message")?.hasAttribute("disabled")).toBe(true)
    await key("Enter")
    expect(p.onSend).not.toHaveBeenCalled()
  })
})
