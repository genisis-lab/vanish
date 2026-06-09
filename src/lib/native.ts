// Native (Capacitor) shell integration.
//
// IMPORTANT: there are NO static imports of Capacitor here. The web build must
// never depend on Capacitor being installed, so we detect the native runtime at
// runtime and dynamically import the plugin only then. The dynamic specifier is
// a variable + /* @vite-ignore */ so Vite/TS never try to resolve the module
// during the normal web build.
//
// What this does inside the native iOS/Android wrapper:
//   - hides the gray iOS keyboard accessory / form-assistant bar (the up/down/
//     Done strip) that cannot be removed from web Safari/PWA
//   - ensures the keyboard resize mode is "native" so the webview shrinks with
//     the keyboard, which also removes the composer drift we have to fight in
//     pure web mode
//
// On the web (no Capacitor global) this is a no-op.

type CapacitorGlobal = {
  isNativePlatform?: () => boolean
  getPlatform?: () => string
}

type KeyboardPlugin = {
  setAccessoryBarVisible: (opts: { isVisible: boolean }) => Promise<void>
  setResizeMode?: (opts: { mode: string }) => Promise<void>
}

export async function setupNativeShell(): Promise<void> {
  const cap = (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor
  if (!cap?.isNativePlatform?.()) return

  try {
    const specifier = "@capacitor/keyboard"
    const mod = (await import(/* @vite-ignore */ specifier)) as { Keyboard: KeyboardPlugin }
    const keyboard = mod.Keyboard

    // Prefer native resize so the webview tracks the keyboard without any JS
    // viewport juggling. Safe no-op if the running plugin version lacks it.
    await keyboard.setResizeMode?.({ mode: "native" }).catch(() => {})

    // iOS only: remove the input accessory / form-assistant bar above the
    // keyboard. This is the bar that cannot be hidden from web Safari/PWA.
    if (cap.getPlatform?.() === "ios") {
      await keyboard.setAccessoryBarVisible({ isVisible: false }).catch(() => {})
    }
  } catch {
    /* Keyboard plugin not installed or not available — ignore on web/native. */
  }
}
