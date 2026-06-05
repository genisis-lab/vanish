// Minimal offline app-shell service worker. It only caches static build assets
// (never API responses, never decrypted content). Room data is fetched live and
// kept in memory; nothing sensitive is persisted by the worker.
const CACHE = "vanish-shell-v1"
const SHELL = ["/", "/index.html", "/manifest.webmanifest", "/icon.svg"]

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()))
})

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener("fetch", (event) => {
  const req = event.request
  const url = new URL(req.url)

  // Never cache the API or websocket traffic.
  if (req.method !== "GET" || url.pathname.startsWith("/api/")) return

  // Network-first for navigations so users always get the latest shell.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone()
          caches.open(CACHE).then((c) => c.put("/index.html", copy))
          return res
        })
        .catch(() => caches.match("/index.html").then((r) => r || Response.error())),
    )
    return
  }

  // Cache-first for hashed static assets.
  if (url.pathname.startsWith("/assets/") || SHELL.includes(url.pathname)) {
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        const copy = res.clone()
        caches.open(CACHE).then((c) => c.put(req, copy))
        return res
      })),
    )
  }
})
