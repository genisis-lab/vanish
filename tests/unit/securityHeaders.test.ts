import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const headers = readFileSync(new URL("../../public/_headers", import.meta.url), "utf8")
const csp = headers
  .split("\n")
  .find((line) => line.trimStart().startsWith("Content-Security-Policy:"))

describe("Cloudflare Pages security headers", () => {
  it("allows Web Analytics without weakening inline-script protection", () => {
    expect(csp).toContain("script-src 'self' https://static.cloudflareinsights.com")
    expect(csp).toContain("connect-src 'self' https://cloudflareinsights.com")
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'")
  })
})
