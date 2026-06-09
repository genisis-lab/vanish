import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import App from "./App"
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

// Keep the chat locked to the *visible* viewport. iOS moves the visual viewport
// downward when the keyboard opens; if we only shrink height and leave top at 0,
// the composer appears at the top of the visible area. So we apply offsetTop
// while the keyboard is clearly open, and reset it to 0 when closed to avoid the
// old drift/floating behavior after send/blur.
function syncViewportHeight() {
  const vv = window.visualViewport
  const root = document.documentElement.style
  const layoutHeight = Math.max(
    window.innerHeight || 0,
    document.documentElement.clientHeight || 0,
  )
  const visibleHeight = vv?.height ?? layoutHeight
  const offsetTop = vv?.offsetTop ?? 0
  const keyboardOpen = visibleHeight < layoutHeight - 80 || offsetTop > 20
  const top = keyboardOpen ? Math.max(0, Math.round(offsetTop)) : 0

  root.setProperty("--app-height", Math.round(visibleHeight) + "px")
  root.setProperty("--app-top", top + "px")

  // Keep the layout from accumulating page scroll after iOS keyboard animations.
  if (!keyboardOpen && window.scrollY !== 0) window.scrollTo(0, 0)
}

let viewportRaf = 0
function scheduleViewportSync() {
  if (viewportRaf) cancelAnimationFrame(viewportRaf)
  viewportRaf = requestAnimationFrame(() => {
    viewportRaf = 0
    syncViewportHeight()
  })
}

syncViewportHeight()
window.visualViewport?.addEventListener("resize", scheduleViewportSync)
window.visualViewport?.addEventListener("scroll", scheduleViewportSync)
window.addEventListener("resize", scheduleViewportSync)
window.addEventListener("orientationchange", scheduleViewportSync)
window.addEventListener("focusin", scheduleViewportSync)
window.addEventListener("focusout", () => {
  scheduleViewportSync()
  window.setTimeout(syncViewportHeight, 120)
})

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
