// @vitest-environment happy-dom
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { usePrefs, type Prefs } from "../../src/lib/usePrefs"

let root: Root
let host: HTMLDivElement
let prefs!: Prefs

function Probe() {
  prefs = usePrefs()
  return null
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true)
  localStorage.clear()
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

it("shares read receipts and typing by default, and remembers turning them off", async () => {
  await act(async () => root.render(createElement(Probe)))
  expect(prefs.readReceipts).toBe(true)
  expect(prefs.typingIndicator).toBe(true)
  await act(async () => {
    prefs.toggleReadReceipts()
    prefs.toggleTypingIndicator()
  })
  expect(prefs.readReceipts).toBe(false)
  expect(prefs.typingIndicator).toBe(false)
  expect(localStorage.getItem("vanish.readReceipts")).toBe("0")
  expect(localStorage.getItem("vanish.typingIndicator")).toBe("0")
  // A fresh load on this device keeps them off.
  await act(async () => root.unmount())
  root = createRoot(host)
  await act(async () => root.render(createElement(Probe)))
  expect(prefs.readReceipts).toBe(false)
  expect(prefs.typingIndicator).toBe(false)
})
