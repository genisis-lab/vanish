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

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
