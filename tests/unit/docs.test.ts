import { existsSync, readdirSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { describe, expect, it } from "vitest"

// The README and docs/ are the first thing newcomers read. Keep every relative
// link and image in them pointing at a file that exists, so a rename or move
// can't quietly break the setup instructions or leave a broken screenshot.

const ROOT = resolve(__dirname, "../..")
const docs = ["README.md", ...readdirSync(join(ROOT, "docs")).filter((f) => f.endsWith(".md")).map((f) => `docs/${f}`)]

function localTargets(markdown: string): string[] {
  const targets = new Set<string>()
  for (const match of markdown.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) targets.add(match[1])
  for (const match of markdown.matchAll(/<img[^>]*\ssrc="([^"]+)"/g)) targets.add(match[1])
  return [...targets]
    .filter((target) => !/^(https?:|mailto:|#)/.test(target))
    .map((target) => target.split("#")[0])
    .filter(Boolean)
}

describe("documentation links", () => {
  for (const doc of docs) {
    it(`${doc} only links to files that exist`, () => {
      const markdown = readFileSync(join(ROOT, doc), "utf8")
      const missing = localTargets(markdown).filter((target) => !existsSync(resolve(ROOT, dirname(doc), target)))
      expect(missing).toEqual([])
    })
  }

  it("npm start points at the local runner script", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> }
    const script = pkg.scripts.start.split(" ")[1]
    expect(existsSync(join(ROOT, script))).toBe(true)
  })
})
