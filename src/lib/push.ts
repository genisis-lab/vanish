// Web Push registration for the client. Lets the room wake this browser with a
// background notification even when the tab/PWA is fully closed (the service
// worker handles the `push` event). All of this is best-effort: it silently
// no-ops when push is unsupported, permission isn't granted, or the server has
// no VAPID key configured.
import { api } from "./api"
import type { RoomSession } from "./session"

// Returns a Uint8Array backed by a plain ArrayBuffer (not ArrayBufferLike), as
// required by PushManager.subscribe's applicationServerKey under TS 5.7+.
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4)
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/")
  const raw = atob(b64)
  const buffer = new ArrayBuffer(raw.length)
  const out = new Uint8Array(buffer)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

function pushSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    typeof window !== "undefined" &&
    "PushManager" in window &&
    "Notification" in window
  )
}

let vapidCache: string | null = null
async function getVapidKey(): Promise<string | null> {
  if (vapidCache) return vapidCache
  try {
    const { publicKey } = await api.pushVapid()
    vapidCache = publicKey || null
    return vapidCache
  } catch {
    return null
  }
}

// Subscribe this browser to background push for the room. Idempotent: reuses an
// existing browser subscription when present.
export async function subscribePush(session: RoomSession): Promise<void> {
  if (!pushSupported() || Notification.permission !== "granted") return
  const reg = await navigator.serviceWorker.getRegistration()
  if (!reg || !reg.pushManager) return
  const vapid = await getVapidKey()
  if (!vapid) return
  let sub = await reg.pushManager.getSubscription()
  if (!sub) {
    try {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapid),
      })
    } catch {
      return
    }
  }
  const json = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } }
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) return
  try {
    await api.pushSubscribe({
      roomId: session.invite.roomId,
      accessProof: session.keys.accessProof,
      participantId: session.participantId,
      subscription: {
        endpoint: json.endpoint,
        keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
      },
    })
  } catch {
    /* best effort */
  }
}

// Tell the server to stop pushing to this browser for the room. The browser's
// underlying subscription is left intact so other rooms keep working.
export async function unsubscribePush(session: RoomSession): Promise<void> {
  if (!pushSupported()) return
  const reg = await navigator.serviceWorker.getRegistration()
  const sub = reg ? await reg.pushManager.getSubscription() : null
  if (!sub) return
  try {
    await api.pushUnsubscribe({
      roomId: session.invite.roomId,
      accessProof: session.keys.accessProof,
      endpoint: sub.endpoint,
    })
  } catch {
    /* best effort */
  }
}
