import { defineConfig, type Plugin } from "vite"
import react from "@vitejs/plugin-react"
import { fileURLToPath, URL } from "node:url"
import { dirname, join } from "node:path"
import { createHash } from "node:crypto"
import { writeFileSync } from "node:fs"

// Subresource Integrity (SRI): after the production bundle is generated, hash
// each emitted script/style asset with SHA-384 and inject a matching
// `integrity` attribute into index.html. The browser then refuses to execute
// any asset whose bytes don't match the hash, so a tampered cache, CDN, or
// compromised edge cannot silently swap in malicious code. Build-only and
// dependency-free.
function subresourceIntegrity(): Plugin {
  const sri = (source: string | Uint8Array): string => {
    const buf = typeof source === "string" ? Buffer.from(source, "utf8") : Buffer.from(source)
    return "sha384-" + createHash("sha384").update(buf).digest("base64")
  }
  return {
    name: "vanish-sri",
    apply: "build",
    enforce: "post",
    writeBundle(options, bundle) {
      const hashForUrl = (urlPath: string): string | null => {
        const fileName = urlPath
          .replace(/^https?:\/\/[^/]+/, "")
          .replace(/^\//, "")
          .replace(/^\.\//, "")
        const item = bundle[fileName]
        if (!item) return null
        const source = item.type === "chunk" ? item.code : item.source
        if (source == null) return null
        return sri(source as string | Uint8Array)
      }

      const index = bundle["index.html"]
      if (!index || index.type !== "asset") return
      let html = typeof index.source === "string" ? index.source : Buffer.from(index.source).toString("utf8")
      // Add integrity to module/entry scripts: <script ... src="...">
      html = html.replace(/<script([^>]*\ssrc="([^"]+)"[^>]*)>/g, (tag, attrs, src) => {
        if (/\sintegrity=/.test(tag)) return tag
        const integrity = hashForUrl(src)
        if (!integrity) return tag
        return `<script${attrs} integrity="${integrity}">`
      })
      // Add integrity to stylesheet + modulepreload links.
      html = html.replace(/<link([^>]*\shref="([^"]+)"[^>]*)>/g, (tag, attrs, href) => {
        if (/\sintegrity=/.test(tag)) return tag
        if (!/rel="(?:stylesheet|modulepreload)"/.test(tag)) return tag
        const integrity = hashForUrl(href)
        if (!integrity) return tag
        return `<link${attrs} integrity="${integrity}">`
      })
      index.source = html

      // Vite/Rolldown can emit index.html after generateBundle. Write the
      // final asset here so the integrity digest always matches the bytes on
      // disk (and therefore the bytes served by Cloudflare Pages).
      const outputDir = options.dir ?? (options.file ? dirname(options.file) : undefined)
      if (outputDir) writeFileSync(join(outputDir, index.fileName), html, "utf8")
    },
  }
}

// Vanish frontend build config.
// Output goes to dist/ which Cloudflare Pages serves. Pages Functions live in
// functions/ and are deployed alongside the static assets.
export default defineConfig({
  plugins: [react(), subresourceIntegrity()],
  resolve: {
    alias: {
      "@shared": fileURLToPath(new URL("./shared", import.meta.url)),
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
    target: "es2022",
  },
  server: {
    port: 5173,
  },
})
