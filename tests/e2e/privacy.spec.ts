import { test, expect, type Request } from "@playwright/test"

// Privacy guarantee: nothing the user types in plaintext (message text,
// username, filename) may ever appear in an outbound request body or URL.
// We sniff every request the page makes while creating a room and chatting.

const SECRETS = {
  username: "PlaintextNameZZZ",
  message: "super-secret-plaintext-payload-7788",
  filename: "my-private-filename-9911.png",
}

test("no plaintext is ever sent to the server", async ({ page }) => {
  const offenders: string[] = []
  const needles = Object.values(SECRETS)

  const inspect = (req: Request) => {
    const url = req.url()
    if (!url.includes("/api/")) return
    const haystacks = [url, req.postData() ?? ""]
    for (const h of haystacks) {
      for (const n of needles) {
        if (h.includes(n)) offenders.push(`${n} leaked in ${req.method()} ${url}`)
      }
    }
  }
  page.on("request", inspect)

  await page.goto("/")
  await page.getByRole("tab", { name: /create/i }).click().catch(() => {})
  await page.getByLabel(/display name/i).fill(SECRETS.username)
  await page.getByRole("button", { name: /create encrypted room/i }).click()
  await expect(page.locator(".chat")).toBeVisible()

  await page.getByRole("textbox", { name: "Encrypted message" }).fill(SECRETS.message)
  await page.keyboard.press("Enter")
  await expect(page.getByText(SECRETS.message)).toBeVisible()

  // Give realtime + persistence calls time to flush.
  await page.waitForTimeout(1500)

  expect(offenders, offenders.join("\n")).toHaveLength(0)
})

test("malformed API JSON and invalid room ids fail at the edge", async ({ request }) => {
  const malformed = await request.post("/api/rooms", {
    data: "{not-json",
    headers: { "content-type": "application/json" },
  })
  expect(malformed.status()).toBe(400)

  const invalid = await request.post("/api/session", {
    data: {
      roomId: "../../invalid",
      accessProof: "proof",
      participantId: "participant",
      participantProof: "participant-proof",
    },
  })
  expect(invalid.status()).toBe(400)
})
