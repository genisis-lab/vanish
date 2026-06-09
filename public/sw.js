// Vanish service worker — offline app shell + Web Push receiver.
//
// SECURITY: never caches API responses, media, or anything containing secrets.
// Only static, non-sensitive build assets and the navigation shell are cached.
// Push payloads never contain message content (the server is zero-knowledge),
// so the notification shown here is a generic "new message" ping.
const CACHE = "vanish-shell-v7"
const SHELL = ["/", "/manifest.webmanifest", "/icon.svg"]

self.addEventListener("install", (event) => {
  // Note: we intentionally do NOT call skipWaiting() here. A freshly installed
  // worker waits until the page tells it to activate (see the message handler),
  // so the app can prompt the user to refresh instead of swapping assets out
  // from under an open conversation.
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL))
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

// The page posts SKIP_WAITING when the user accepts an update, letting the
// waiting worker take over immediately (a controllerchange then reloads the
// page). It also posts VANISH_ACTIVE_ROOM as focus/visibility changes; we keep
// this best-effort snapshot to make foreground notification suppression more
// reliable across browsers.
const ACTIVE_WINDOWS = new Map()

self.addEventListener("message", (event) => {
  const data = event.data || {}
  if (data.type === "SKIP_WAITING") {
    self.skipWaiting()
    return
  }
  if (data.type === "VANISH_ACTIVE_ROOM") {
    const id = event.source && event.source.id
    if (id) ACTIVE_WINDOWS.set(id, { room: data.room || null, visible: !!data.visible, at: Date.now() })
  }
})

// Background Web Push: wake the app and show a content-free notification. The
// payload carries no message text (the server can't read it); tapping opens the
// app, which decrypts and renders the conversation.
//
// Policy: if Vanish is visibly open anywhere, stay silent. The running app's
// in-app UI handles visible activity, and users shouldn't get redundant system
// notifications while actively using Vanish — whether they're in the same room,
// another room, the home screen, or the vault lock screen. If every Vanish
// window is hidden/backgrounded/minimized, or the app is fully closed, show the
// generic push notification.
self.addEventListener("push", (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = {}
  }
  const room = data && data.room ? data.room : null
  const tag = room ? "vanish-" + room : "vanish-message"
  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      })
      if (await someVisibleVanishWindow(clients)) return
      await self.registration.showNotification("Vanish", {
        body: "New encrypted message",
        tag,
        renotify: true,
        icon: "/icon.svg",
        badge: "/icon.svg",
      })
    })(),
  )
})

// Resolve true if any Vanish window is currently visible/foreground. Prefer the
// WindowClient runtime flags when available, fall back to the page's own
// MessageChannel answer, and finally use the last focus/visibility snapshot the
// page posted. If everything is hidden or no clients exist, pushes are allowed.
function someVisibleVanishWindow(clients) {
  if (!clients || clients.length === 0) return Promise.resolve(false)

  // Native WindowClient properties are the fastest and work even if the page is
  // between React states. Not all browsers expose both, so check defensively.
  for (const c of clients) {
    if (c.visibilityState === "visible" || c.focused === true) return Promise.resolve(true)
  }

  return Promise.all(clients.map((c) => askClientRoom(c))).then((states) => {
    if (states.some((s) => s && s.visible)) return true

    // Best-effort fallback: use recent page-posted snapshots for clients that
    // did not answer the private channel quickly enough.
    const now = Date.now()
    for (const c of clients) {
      const cached = ACTIVE_WINDOWS.get(c.id)
      if (cached && cached.visible && now - cached.at < 30000) return true
    }
    return false
  })
}

function askClientRoom(client) {
  return new Promise((resolve) => {
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      resolve(value)
    }
    try {
      const channel = new MessageChannel()
      channel.port1.onmessage = (event) => finish(event.data || null)
      client.postMessage({ type: "VANISH_WHICH_ROOM" }, [channel.port2])
    } catch {
      finish(null)
    }
    // Don't let an unresponsive window (e.g. mid-reload) stall the push.
    setTimeout(() => finish(null), 350)
  })
}

// Focus an existing window when a message notification is clicked, or open one.
self.addEventListener("notificationclick", (event) => {
  event.notification.close()
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clients) => {
        for (const client of clients) {
          if ("focus" in client) return client.focus()
        }
        if (self.clients.openWindow) return self.clients.openWindow("/")
        return undefined
      }),
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
