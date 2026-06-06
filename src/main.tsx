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
      .register("/sw.js")
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

// Keep a CSS var in sync with the *visible* viewport height so the chat
// layout shrinks when the mobile keyboard opens, instead of the composer
// being pushed below the keyboard (which forced users to scroll up).
function syncViewportHeight() {
  const vv = window.visualViewport
  const h = vv?.height ?? window.innerHeight
  // offsetTop is how far the keyboard has pushed the *visible* window down from
  // the document top. We shift the app by it so the composer stays pinned to
  // the visible area instead of leaving a gap below it.
  const top = vv?.offsetTop ?? 0
  const root = document.documentElement.style
  root.setProperty("--app-height", h + "px")
  root.setProperty("--app-top", top + "px")
}
syncViewportHeight()
window.visualViewport?.addEventListener("resize", syncViewportHeight)
window.visualViewport?.addEventListener("scroll", syncViewportHeight)
window.addEventListener("resize", syncViewportHeight)
window.addEventListener("orientationchange", syncViewportHeight)

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
