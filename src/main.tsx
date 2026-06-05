import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import App from "./App"
import "./styles/index.css"
import "./styles/chat-refresh.css"
import "./styles/enhancements.css"

// Register the service worker for PWA/offline shell (best-effort).
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {})
  })
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
