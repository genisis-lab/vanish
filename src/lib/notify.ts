// Local message notifications, with first-class PWA support.
//
// These are *local* notifications fired from the running app or its service
// worker — there is no push server and no subscription. Nothing extra leaves
// the device: the message is decrypted on-device (in useRoom) and only the
// already-visible sender name + a short preview are shown. We prefer the
// service worker registration's showNotification() because installed PWAs
// (especially on Android) cannot use the page-level `new Notification()`.

const PREF_KEY = "vanish.notify"

export function notificationsSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window
}

export function notificationPermission(): NotificationPermission {
  if (!notificationsSupported()) return "denied"
  return Notification.permission
}

// User preference, independent of the OS permission. Defaults to on so that
// once permission is granted notifications work without a second opt-in.
export function notificationsEnabled(): boolean {
  if (!notificationsSupported() || Notification.permission !== "granted") return false
  try {
    return localStorage.getItem(PREF_KEY) !== "0"
  } catch {
    return true
  }
}

export function setNotificationsEnabled(on: boolean): void {
  try {
    localStorage.setItem(PREF_KEY, on ? "1" : "0")
  } catch {
    /* storage unavailable — ignore */
  }
}

export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (!notificationsSupported()) return "denied"
  if (Notification.permission !== "default") return Notification.permission
  try {
    return await Notification.requestPermission()
  } catch {
    return Notification.permission
  }
}

// One-call helper for an explicit, user-initiated "enable notifications"
// control. Requests OS permission when needed and flips the local pref on.
// Returns a short status the UI can surface as a toast.
export async function enableNotifications(): Promise<
  "enabled" | "blocked" | "unsupported"
> {
  if (!notificationsSupported()) return "unsupported"
  let permission = Notification.permission
  if (permission === "default") permission = await requestNotificationPermission()
  if (permission !== "granted") return "blocked"
  setNotificationsEnabled(true)
  return "enabled"
}

let promptArmed = false

// Browsers only show the permission prompt in response to a user gesture, so
// we arm one-time listeners instead of prompting on load. No-op once the user
// has already allowed or denied notifications.
export function ensureNotificationPrompt(): void {
  if (!notificationsSupported() || Notification.permission !== "default" || promptArmed) return
  promptArmed = true
  const handler = () => {
    cleanup()
    void requestNotificationPermission()
  }
  const cleanup = () => {
    window.removeEventListener("pointerdown", handler)
    window.removeEventListener("keydown", handler)
  }
  window.addEventListener("pointerdown", handler, { once: true })
  window.addEventListener("keydown", handler, { once: true })
}

let lastNotification: Notification | null = null

// `renotify` is valid at runtime (and requires `tag`) but isn't declared on
// NotificationOptions in this project's DOM lib, so widen the payload type.
type VanishNotificationOptions = NotificationOptions & { renotify?: boolean }

export async function showMessageNotification(opts: {
  title: string
  body: string
  tag?: string
}): Promise<void> {
  if (!notificationsEnabled()) return
  // Never interrupt while the tab is actually in the foreground.
  if (typeof document !== "undefined" && document.visibilityState === "visible") return

  const payload: VanishNotificationOptions = {
    body: opts.body,
    tag: opts.tag || "vanish-message",
    icon: "/icon.svg",
    badge: "/icon.svg",
    renotify: true,
  }

  // Prefer the service worker registration (required inside an installed PWA).
  try {
    if ("serviceWorker" in navigator) {
      const reg = await navigator.serviceWorker.getRegistration()
      if (reg && "showNotification" in reg) {
        await reg.showNotification(opts.title, payload)
        return
      }
    }
  } catch {
    /* fall through to the page-level Notification */
  }

  try {
    lastNotification?.close()
    lastNotification = new Notification(opts.title, payload)
    lastNotification.onclick = () => {
      try {
        window.focus()
      } catch {
        /* ignore */
      }
      lastNotification?.close()
    }
  } catch {
    /* notifications unavailable in this context — ignore */
  }
}
