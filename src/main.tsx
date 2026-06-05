import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import App from "./App"
import "./styles/index.css"
import "./styles/chat-refresh.css"

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
  const h = window.visualViewport?.height ?? window.innerHeight
  document.documentElement.style.setProperty("--app-height", h + "px")
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
