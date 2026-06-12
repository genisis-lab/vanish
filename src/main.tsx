import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import App from "./App"
import { setupNativeShell } from "./lib/native"
import "./styles/index.css"
import "./styles/chat-refresh.css"
import "./styles/enhancements.css"

// Register the service worker for PWA/offline shell (best-effort), and surface a
// gentle refresh prompt when a newer build has been deployed.
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      // updateViaCache:"none" makes the browser bypass its HTTP cache when
      // checking sw.js, so update() reliably notices a freshly deployed build.
      .register("/sw.js", { updateViaCache: "none" })
      .then((reg) => {
        if (reg.waiting) promptUpdate(reg)
        reg.addEventListener("updatefound", () => {
          const sw = reg.installing
          if (!sw) return
          sw.addEventListener("statechange", () => {
            // A new worker finished installing while an old one still controls
            // the page => there is an update waiting to take over.
            if (sw.state === "installed" && navigator.serviceWorker.controller) {
              promptUpdate(reg)
            }
          })
        })

        // Proactively poll for a new build so the refresh prompt appears
        // promptly, instead of only after a full tab reload or PWA relaunch.
        // We check shortly after load, on a steady interval, and whenever the
        // app regains focus/visibility (e.g. switching back to the PWA).
        const checkForUpdate = () => {
          reg.update().catch(() => {})
        }
        checkForUpdate()
        setInterval(checkForUpdate, 60_000)
        document.addEventListener("visibilitychange", () => {
          if (document.visibilityState === "visible") checkForUpdate()
        })
        window.addEventListener("focus", checkForUpdate)
      })
      .catch(() => {})

    // When the waiting worker activates, reload once to pick up the new assets.
    let reloaded = false
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (reloaded) return
      reloaded = true
      window.location.reload()
    })
  })
}

function promptUpdate(reg: ServiceWorkerRegistration) {
  if (document.getElementById("vanish-update-bar")) return
  const bar = document.createElement("div")
  bar.id = "vanish-update-bar"
  bar.setAttribute("role", "status")
  bar.style.cssText =
    "position:fixed;left:50%;transform:translateX(-50%);bottom:calc(16px + env(safe-area-inset-bottom));z-index:9999;display:flex;align-items:center;gap:12px;padding:10px 14px;border-radius:12px;background:#1c1c28;color:#fff;box-shadow:0 8px 30px rgba(0,0,0,.35);font:500 14px system-ui,sans-serif;max-width:calc(100vw - 32px)"
  const label = document.createElement("span")
  label.textContent = "A new version of Vanish is available."
  const btn = document.createElement("button")
  btn.textContent = "Refresh"
  btn.style.cssText =
    "border:none;border-radius:8px;padding:6px 12px;background:#7c83fd;color:#fff;font:600 14px system-ui,sans-serif;cursor:pointer"
  btn.onclick = () => {
    reg.waiting?.postMessage({ type: "SKIP_WAITING" })
    btn.disabled = true
    btn.textContent = "Refreshing\u2026"
  }
  const dismiss = document.createElement("button")
  dismiss.textContent = "Later"
  dismiss.setAttribute("aria-label", "Dismiss update notice")
  dismiss.style.cssText =
    "border:none;background:transparent;color:#aaa;font:500 13px system-ui,sans-serif;cursor:pointer"
  dismiss.onclick = () => bar.remove()
  bar.append(label, btn, dismiss)
  document.body.appendChild(bar)
}

function isStandaloneDisplay() {
  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    (navigator as unknown as { standalone?: boolean }).standalone === true
  )
}

// ---------- desktop PWA install polish ----------
//
// Chromium desktop/Android fire `beforeinstallprompt` when the app is
// installable. We capture it, suppress the default mini-infobar, and show our
// own tidy "Install" bar so installing Vanish on desktop is a first-class,
// on-brand action. Built in vanilla DOM (like the update bar) so it never
// touches the React tree. Does nothing on iOS Safari (no event) or when the
// app is already running standalone.
function setupInstallPrompt() {
  if (isStandaloneDisplay()) return

  let deferred: (Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> }) | null =
    null
  const DISMISS_KEY = "vanish.install.dismissed.v1"

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault()
    deferred = e as never
    try {
      if (sessionStorage.getItem(DISMISS_KEY) === "1") return
    } catch {
      /* ignore */
    }
    showInstallBar()
  })

  window.addEventListener("appinstalled", () => {
    document.getElementById("vanish-install-bar")?.remove()
    deferred = null
  })

  function showInstallBar() {
    if (document.getElementById("vanish-install-bar")) return
    const bar = document.createElement("div")
    bar.id = "vanish-install-bar"
    bar.setAttribute("role", "dialog")
    bar.setAttribute("aria-label", "Install Vanish")
    bar.style.cssText =
      "position:fixed;left:50%;transform:translateX(-50%);bottom:calc(16px + env(safe-area-inset-bottom));z-index:9998;display:flex;align-items:center;gap:12px;padding:10px 14px;border-radius:12px;background:#15151f;color:#fff;box-shadow:0 8px 30px rgba(0,0,0,.4);font:500 14px system-ui,sans-serif;max-width:calc(100vw - 32px)"
    const label = document.createElement("span")
    label.textContent = "Install Vanish for a faster, standalone window."
    const btn = document.createElement("button")
    btn.textContent = "Install"
    btn.style.cssText =
      "border:none;border-radius:8px;padding:6px 14px;background:#7c83fd;color:#fff;font:600 14px system-ui,sans-serif;cursor:pointer"
    btn.onclick = async () => {
      if (!deferred) return
      btn.disabled = true
      try {
        await deferred.prompt()
        await deferred.userChoice
      } catch {
        /* ignore */
      }
      deferred = null
      bar.remove()
    }
    const dismiss = document.createElement("button")
    dismiss.textContent = "Not now"
    dismiss.setAttribute("aria-label", "Dismiss install prompt")
    dismiss.style.cssText =
      "border:none;background:transparent;color:#aaa;font:500 13px system-ui,sans-serif;cursor:pointer"
    dismiss.onclick = () => {
      try {
        sessionStorage.setItem(DISMISS_KEY, "1")
      } catch {
        /* ignore */
      }
      bar.remove()
    }
    bar.append(label, btn, dismiss)
    document.body.appendChild(bar)
  }
}
setupInstallPrompt()

// Initialize the native shell (no-op on web). Removes the iOS keyboard
// accessory bar and enables native keyboard resize inside the Capacitor wrapper.
void setupNativeShell()

// ---------- mobile keyboard / viewport ----------
//
// Mobile browser tabs resize visualViewport while the address/tool bars animate
// during normal scroll. Do not mirror those scroll-driven values into app layout:
// it creates a feedback loop where Safari/Chrome move the page and the app moves
// in response. Keep browser-tab layout on stable svh, and only mirror the visual
// viewport while text entry is focused, when the keyboard actually needs room.
function syncViewport() {
  const root = document.documentElement.style
  const vv = window.visualViewport
  const chatMounted = document.querySelector(".app > .chat")
  const focused = document.activeElement
  const textEntryFocused =
    focused instanceof HTMLElement &&
    (focused.isContentEditable || focused.matches("input, textarea, [contenteditable]"))
  const shouldTrackViewport = Boolean(chatMounted && vv && (isStandaloneDisplay() || textEntryFocused))

  if (!shouldTrackViewport) {
    root.setProperty("--app-height", "100svh")
    root.setProperty("--app-top", "0px")
    return
  }

  root.setProperty("--app-height", Math.round(vv.height) + "px")
  root.setProperty("--app-top", Math.max(0, Math.round(vv.offsetTop)) + "px")
}

let viewportRaf = 0
function scheduleViewportSync() {
  if (viewportRaf) cancelAnimationFrame(viewportRaf)
  viewportRaf = requestAnimationFrame(() => {
    viewportRaf = 0
    syncViewport()
  })
}

syncViewport()
window.visualViewport?.addEventListener("resize", scheduleViewportSync)
window.addEventListener("resize", scheduleViewportSync)
window.addEventListener("orientationchange", scheduleViewportSync)
window.addEventListener("focusin", scheduleViewportSync)
// iOS sometimes omits a final resize after dismissing the keyboard; re-sync on
// blur (with a short delay) so the layout reliably returns to the bottom.
window.addEventListener("focusout", () => {
  scheduleViewportSync()
  window.setTimeout(syncViewport, 250)
})

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
