import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const headers = readFileSync(new URL("../../public/_headers", import.meta.url), "utf8")
const securityTxt = readFileSync(
  new URL("../../public/.well-known/security.txt", import.meta.url),
  "utf8",
)
const csp = headers
  .split("\n")
  .find((line) => line.trimStart().startsWith("Content-Security-Policy:"))

describe("Cloudflare Pages security headers", () => {
  it("allows Web Analytics without weakening inline-script protection", () => {
    expect(csp).toContain("script-src 'self' https://static.cloudflareinsights.com")
    expect(csp).toContain("connect-src 'self' https://cloudflareinsights.com")
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'")
  })

  it("serves a canonical text/plain security.txt outside the API function routes", () => {
    expect(headers).toMatch(
      /\/\.well-known\/security\.txt\s+Content-Type: text\/plain; charset=utf-8/,
    )
    expect(securityTxt).toContain(
      "Contact: https://github.com/genisis-lab/vanish/security/advisories/new",
    )
    expect(securityTxt).toContain("Expires: 2027-08-13T00:00:00Z")
    expect(securityTxt).toContain(
      "Canonical: https://chat.builtwai.com/.well-known/security.txt",
    )
  })
})
