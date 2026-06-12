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

// ---------- desktop PWA install polish ----------
//
// Chromium desktop/Android fire `beforeinstallprompt` when the app is
// installable. We capture it, suppress the default mini-infobar, and show our
// own tidy "Install" bar so installing Vanish on desktop is a first-class,
// on-brand action. Built in vanilla DOM (like the update bar) so it never
// touches the React tree. Does nothing on iOS Safari (no event) or when the
// app is already running standalone.
function setupInstallPrompt() {
  const isStandalone =
    window.matchMedia?.("(display-mode: standalone)").matches ||
    (navigator as unknown as { standalone?: boolean }).standalone === true
  if (isStandalone) return

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
// On the web we mirror window.visualViewport exactly: the chat is pinned to the
// visible viewport's rectangle. height = visualViewport.height and a composited
// translateY = visualViewport.offsetTop. This tracks the keyboard precisely and
// returns to the bottom (offsetTop 0, full height) when the keyboard closes, so
// the composer no longer drifts to the top or fails to return to the bottom.
//
// In the native wrapper the keyboard plugin resizes the webview natively, so
// visualViewport already reports the shrunken size and offsetTop stays 0 — this
// code then simply mirrors the full height with no offset.
function syncViewport() {
  const root = document.documentElement.style
  const vv = window.visualViewport
  // This viewport pinning + scroll-reset only applies to the chat view, whose
  // app shell is position:fixed and tracks the on-screen keyboard. The home /
  // landing screen scrolls normally through the document. Running this on every
  // scroll-driven visualViewport event there forces layout each frame (stutter)
  // and — because offsetTop is 0 while the page is merely scrolled — fires
  // window.scrollTo(0, 0), yanking the page back to the top ("scroll up shoots
  // up fast"). So do nothing unless the chat shell is actually mounted.
  if (!document.querySelector(".app > .chat")) return
  if (!vv) {
    root.setProperty("--app-height", (window.innerHeight || 0) + "px")
    root.setProperty("--app-top", "0px")
    return
  }
  root.setProperty("--app-height", Math.round(vv.height) + "px")
  root.setProperty("--app-top", Math.max(0, Math.round(vv.offsetTop)) + "px")
  // Avoid leftover layout-viewport scroll once the keyboard is fully closed.
  if (vv.offsetTop === 0 && window.scrollY !== 0) window.scrollTo(0, 0)
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
window.visualViewport?.addEventListener("scroll", scheduleViewportSync)
window.addEventListener("resize", scheduleViewportSync)
window.addEventListener("orientationchange", scheduleViewportSync)
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
