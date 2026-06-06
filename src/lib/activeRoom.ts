// Tracks which room (if any) is currently on-screen and answers the service
// worker when a background push arrives. This lets the SW decide whether to
// stay silent (you're already looking at that exact room, so the in-app UI
// handles it) or alert you (the push is for a different room you've joined, or
// Vanish is backgrounded) — so notifications for other rooms keep arriving even
// while the app is open.

let currentRoom: string | null = null
let wired = false

// Whether this window is currently in the foreground.
function isVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState === "visible"
}

// The snapshot the service worker uses to decide whether to show a push.
function snapshot(): { room: string | null; visible: boolean } {
  return { room: currentRoom, visible: isVisible() }
}

function postActive(): void {
  try {
    navigator.serviceWorker?.controller?.postMessage({ type: "VANISH_ACTIVE_ROOM", ...snapshot() })
  } catch {
    /* best effort */
  }
}

// Lazily attach a single listener that answers the SW's per-push room query and
// keeps it loosely informed as focus/visibility change.
function ensureWired(): void {
  if (wired) return
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return
  wired = true
  navigator.serviceWorker.addEventListener("message", (event) => {
    const data = event.data as { type?: string } | undefined
    if (!data || data.type !== "VANISH_WHICH_ROOM") return
    const port = event.ports && event.ports[0]
    if (port) port.postMessage(snapshot())
    else postActive()
  })
  document.addEventListener("visibilitychange", postActive)
  window.addEventListener("focus", postActive)
  window.addEventListener("blur", postActive)
}

// Called by the app's router: pass the room id while a room is on screen, or
// null when it isn't (home screen, join screen, locked vault).
export function setActiveRoom(roomId: string | null): void {
  currentRoom = roomId
  ensureWired()
  postActive()
}
