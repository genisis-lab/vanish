# Vanish native wrappers (iOS / Android) + desktop install

Vanish is a PWA first. For app-store distribution we wrap the **deployed** PWA in
a thin native shell with [Capacitor](https://capacitorjs.com): a WKWebView on
iOS and an Android WebView. There is no second codebase — the shell loads the
same live site, so the Cloudflare backend (`/api/*`, WebSockets, R2) keeps
working unchanged.

> The web build never imports Capacitor, so installing it is **optional** and
> only needed when you actually want native builds.

## 1. Install Capacitor (one time)

```bash
npm install @capacitor/core
npm install -D @capacitor/cli
npm install @capacitor/ios @capacitor/android
npm install @capacitor/keyboard
```

`capacitor.config.ts` is already in the repo. It points the webview at the
deployed origin (`https://vanish-6fb.pages.dev` by default — change `server.url`
to your custom domain if you have one) and configures the Keyboard plugin.

## 2. Add the native platforms

```bash
npm run build            # produce dist/ (used as the fallback webDir)
npx cap add ios
npx cap add android
npm run cap:sync         # copies config + web assets into the native projects
```

## 3. iOS (WKWebView)

```bash
npm run cap:ios          # opens Xcode
```

In Xcode:

1. Select the **App** target → Signing & Capabilities → set your Team.
2. Add these keys to `ios/App/App/Info.plist` so QR scanning and voice notes
   are allowed in the webview:
   - `NSCameraUsageDescription` — “Scan a sync QR code to link a device.”
   - `NSMicrophoneUsageDescription` — “Record encrypted voice notes.”
3. Build/run on a device or archive for TestFlight / App Store.

Notes:
- The shell loads the live HTTPS origin, so cookies/storage are scoped to that
  origin and survive app restarts.
- Push notifications inside the wrapper use the site’s existing Web Push; for
  true APNs you would add `@capacitor/push-notifications` later.

## 4. Android (WebView)

```bash
npm run cap:android      # opens Android Studio
```

Add to `android/app/src/main/AndroidManifest.xml` inside `<manifest>`:

```xml
<uses-permission android:name="android.permission.CAMERA" />
<uses-permission android:name="android.permission.RECORD_AUDIO" />
<uses-permission android:name="android.permission.INTERNET" />
```

Then build an AAB/APK from Android Studio.

## 5. Keyboard: accessory bar + native resize (the iOS gray bar fix)

Web Safari/PWA renders a gray **input accessory / form-assistant bar** above the
keyboard (the up/down arrows + Done/check strip). It is owned by iOS and
**cannot be removed from web Safari or an installed PWA**. The native wrapper is
the only way to remove it.

This repo already wires it up:

- `capacitor.config.ts` sets:
  ```ts
  plugins: {
    Keyboard: { resize: "native", resizeOnFullScreen: true },
  }
  ```
  `resize: "native"` makes the WKWebView/WebView shrink with the keyboard, so
  the composer sits naturally above it with no JS viewport math.
- `src/lib/native.ts` runs only inside the native shell (detected at runtime via
  the `Capacitor` global, dynamic import so the web build never depends on it)
  and calls:
  ```ts
  Keyboard.setResizeMode({ mode: "native" })
  Keyboard.setAccessoryBarVisible({ isVisible: false }) // iOS only
  ```
  `setAccessoryBarVisible(false)` is what removes the gray accessory bar.

So after `npm install @capacitor/keyboard` and `npm run cap:sync`, the native
iOS build has no accessory bar and the keyboard resizes natively. On the web the
same code is a no-op and the composer is positioned by mirroring
`window.visualViewport` (see `src/main.tsx`).

## 6. Updating the wrapper

Because the shell loads the live site, **most updates ship instantly** the
moment you redeploy the PWA — no app-store review needed. Only re-release the
native build when you change `capacitor.config.ts`, icons, or native plugins:

```bash
npm run build && npm run cap:sync
```

## 7. Browser install (PWA)

No wrapper needed for browser installs. Vanish is an installable PWA:

- **Chrome / Edge / Brave:** an **Install Vanish** bar appears automatically
  (handled in `src/main.tsx` via the `beforeinstallprompt` event), or use the
  install icon in the address bar.
- **iPhone / iPad browsers:** the Home screen shows an install card with the
  Share -> Add to Home Screen flow. iOS does not expose the same install prompt
  event that Chromium does.
- **Safari (macOS):** File → Add to Dock.
- Once installed it runs in its own standalone window with the service worker
  providing the offline app shell.
