// Capacitor configuration for the Vanish native wrapper (iOS + Android).
//
// Strategy: the native shell is a thin WKWebView (iOS) / Android WebView that
// loads the *deployed* Vanish PWA. We deliberately load the live origin rather
// than bundling the static site, because the app needs the Cloudflare backend
// (/api/*) to function — a bundled capacitor://localhost origin has no server.
//
// This file is authored as a plain object with NO @capacitor/cli type import so
// the web build never depends on Capacitor being installed. See docs/NATIVE.md.

const config = {
  appId: "app.vanish.client",
  appName: "Vanish",
  // Fallback static dir (used only if you switch to a bundled build).
  webDir: "dist",
  server: {
    // The deployed Vanish origin the webview loads. Change to your custom
    // domain if you have one (e.g. https://vanish.app).
    url: "https://vanish-6fb.pages.dev",
    cleartext: false,
    androidScheme: "https",
    iosScheme: "https",
  },
  ios: {
    contentInset: "always",
    backgroundColor: "#0b0b0f",
    // QR scanning (multi-device sync) + voice notes need camera/mic; the usage
    // strings live in ios/App/App/Info.plist (see docs/NATIVE.md).
    limitsNavigationsToAppBoundDomains: false,
  },
  android: {
    backgroundColor: "#0b0b0f",
    allowMixedContent: false,
  },
  plugins: {
    // Native keyboard handling. resize: "native" makes the WKWebView/WebView
    // shrink with the keyboard (no JS viewport math needed in the shell), and
    // we additionally hide the iOS input accessory / form-assistant bar at
    // runtime in src/lib/native.ts via setAccessoryBarVisible(false).
    Keyboard: {
      resize: "native",
      resizeOnFullScreen: true,
    },
  },
}

export default config
