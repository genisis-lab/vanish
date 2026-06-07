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
```

`capacitor.config.ts` is already in the repo. It points the webview at the
deployed origin (`https://vanish-6fb.pages.dev` by default — change `server.url`
to your custom domain if you have one).

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

## 5. Updating the wrapper

Because the shell loads the live site, **most updates ship instantly** the
moment you redeploy the PWA — no app-store review needed. Only re-release the
native build when you change `capacitor.config.ts`, icons, or native plugins:

```bash
npm run build && npm run cap:sync
```

## 6. Desktop install (PWA)

No wrapper needed on desktop. Vanish is an installable PWA:

- **Chrome / Edge / Brave:** an **Install Vanish** bar appears automatically
  (handled in `src/main.tsx` via the `beforeinstallprompt` event), or use the
  install icon in the address bar.
- **Safari (macOS):** File → Add to Dock.
- Once installed it runs in its own standalone window with the service worker
  providing the offline app shell.
