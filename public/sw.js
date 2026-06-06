// Vanish service worker — offline app shell + Web Push receiver.
//
// SECURITY: never caches API responses, media, or anything containing secrets.
// Only static, non-sensitive build assets and the navigation shell are cached.
// Push payloads never contain message content (the server is zero-knowledge),
// so the notification shown here is a generic "new message" ping.
const CACHE = "vanish-shell-v6"
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

// The page posts this when the user accepts an update, letting the waiting
// worker take over immediately (a controllerchange then reloads the page).
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting()
})

// Background Web Push: wake the app and show a content-free notification. The
// payload carries no message text (the server can't read it); tapping opens the
// app, which decrypts and renders the conversation.
//
// We only stay silent when a *visible* window is already showing THIS room —
// then the in-app UI handles it. If the app is backgrounded, sitting on the
// home screen, or showing a *different* room you've joined, we still alert you,
// so notifications for your other rooms keep coming through even with Vanish
// open.
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
      if (await someClientViewingRoom(clients, room)) return
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

// Resolve true only if some *visible* window reports that it is currently
// showing the given room. Each window is asked over a private MessageChannel;
// if nobody answers promptly we resolve false so a push is never silently
// dropped (worst case: a redundant alert for a room you're actually viewing).
function someClientViewingRoom(clients, room) {
  if (!room || !clients || clients.length === 0) return Promise.resolve(false)
  return Promise.all(clients.map((c) => askClientRoom(c))).then((states) =>
    states.some((s) => s && s.visible && s.room === room),
  )
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
