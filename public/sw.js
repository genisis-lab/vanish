// Vanish service worker — offline app shell only.
//
// SECURITY: never caches API responses, media, or anything containing secrets.
// Only static, non-sensitive build assets and the navigation shell are cached.
const CACHE = "vanish-shell-v1"
const SHELL = ["/", "/manifest.webmanifest", "/icon.svg"]

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(() => {}),
  )
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
  if (req.method !== "GET") return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return
  // Never touch API or upload traffic.
  if (url.pathname.startsWith("/api/")) return

  // Navigations: network-first, fall back to the cached shell when offline.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).catch(() => caches.match("/").then((r) => r || caches.match("/index.html"))),
    )
    return
  }

  // Static assets: stale-while-revalidate.
  if (/\.(?:js|css|svg|png|ico|woff2?|webmanifest)$/.test(url.pathname)) {
    event.respondWith(
      caches.open(CACHE).then(async (cache) => {
        const cached = await cache.match(req)
        const network = fetch(req)
          .then((res) => {
            if (res && res.ok) cache.put(req, res.clone())
            return res
          })
          .catch(() => cached)
        return cached || network
      }),
    )
  }
})
