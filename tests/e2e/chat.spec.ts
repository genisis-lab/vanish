import { test, expect, type Page, type Request } from "@playwright/test"
import path from "node:path"
import fs from "node:fs"
import os from "node:os"

// End-to-end happy path across two isolated origins (independent browser
// storage) exercising create, join, live text, media, prune, and delete.

async function createRoom(page: Page, username: string): Promise<string> {
  await page.goto("/")
  await page.getByRole("tab", { name: /create/i }).click().catch(() => {})
  await page.getByLabel(/display name/i).fill(username)
  await page.getByRole("button", { name: /create encrypted room/i }).click()
  // Land in the chat room.
  await expect(page.locator(".chat")).toBeVisible()
  // Grab the invite link from the Invite panel.
  await page.getByRole("button", { name: "Invite", exact: true }).click()
  const link = await page.locator(".copy-field .box").first().innerText()
  await page.keyboard.press("Escape")
  expect(link).toContain("#invite=")
  return link
}

async function joinRoom(page: Page, inviteUrl: string, username: string): Promise<Page> {
  // The creator's active session is already in memory; clear shared persistence
  // so this preloaded second page behaves as a fresh anonymous device.
  await page.evaluate(() => window.localStorage.clear())
  await page.getByRole("tab", { name: /join with key/i }).click()
  await page.getByLabel(/invite key or link/i).fill(inviteUrl)
  await page.getByRole("button", { name: /continue/i }).click()
  await expect(page.getByText(/valid invite|join room/i)).toBeVisible()
  await page.getByLabel(/display name/i).fill(username)
  await page.getByRole("button", { name: /join room/i }).click()
  await expect(page.locator(".chat")).toBeVisible()
  return page
}

const PRIVATE_VALUES = {
  username: "PlaintextNameZZZ",
  message: "super-secret-plaintext-payload-7788",
  filename: "my-private-filename-9911.png",
}

test("two anonymous users chat, share media, prune, and delete", async ({ browser }) => {
  const ctx = await browser.newContext({ serviceWorkers: "block" })
  const alice = await ctx.newPage()
  const bobPage = await ctx.newPage()
  await Promise.all([alice.goto("/"), bobPage.goto("/")])

  // Sniff sender API requests throughout the real chat flow. Human-readable
  // identity/message/filename values must only appear inside client ciphertext.
  const offenders: string[] = []
  const inspect = (request: Request) => {
    if (!request.url().includes("/api/")) return
    const contentType = request.headers()["content-type"] ?? ""
    const haystacks = [request.url()]
    if (contentType.includes("json")) haystacks.push(request.postData() ?? "")
    for (const value of Object.values(PRIVATE_VALUES)) {
      if (haystacks.some((haystack) => haystack.includes(value))) {
        offenders.push(`${value} leaked in ${request.method()} ${request.url()}`)
      }
    }
  }
  alice.on("request", inspect)

  const inviteUrl = await createRoom(alice, PRIVATE_VALUES.username)
  const bob = await joinRoom(bobPage, inviteUrl, "Ember")
  await expect(alice.getByText("Ember joined the room", { exact: true })).toBeVisible()

  // Live text from Ash arrives for Ember.
  await alice.getByRole("textbox", { name: "Encrypted message" }).fill(PRIVATE_VALUES.message)
  await alice.keyboard.press("Enter")
  await expect(bob.getByText(PRIVATE_VALUES.message)).toBeVisible()

  // Live text back from Ember arrives for Ash.
  await bob.getByRole("textbox", { name: "Encrypted message" }).fill("hi ember here")
  await bob.keyboard.press("Enter")
  await expect(alice.getByText("hi ember here")).toBeVisible()

  // Ash uploads an image; Ember can decrypt + view it.
  const tmp = path.join(os.tmpdir(), PRIVATE_VALUES.filename)
  // 1x1 PNG
  fs.writeFileSync(
    tmp,
    Buffer.from(
      "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da6364f8cf00000201010019389a0a0000000049454e44ae426082",
      "hex",
    ),
  )
  await alice.locator('input[type="file"]').setInputFiles(tmp)
  const signed = alice.waitForResponse((response) => response.url().includes("/api/uploads/sign"))
  const uploaded = alice.waitForResponse((response) => response.url().includes("/api/uploads/put"))
  await alice.getByRole("button", { name: "Send message" }).click()
  const signResponse = await signed
  expect(signResponse.ok(), await signResponse.text()).toBe(true)
  const uploadResponse = await uploaded
  expect(uploadResponse.ok(), await uploadResponse.text()).toBe(true)
  const tile = bob.locator(".media-tile").first()
  await expect(tile).toBeVisible({ timeout: 20_000 })
  await tile.click() // decrypt
  await expect(bob.locator(".media-tile img, .media-tile video")).toBeVisible({ timeout: 20_000 })

  // Files above the small-object threshold use independently encrypted R2
  // multipart chunks instead of crossing the Worker request-size boundary.
  const multipartBytes = Buffer.alloc(16 * 1024 * 1024 + 1, 0x5a)
  await alice.locator('input[type="file"]').setInputFiles({
    name: "multipart-test.webm",
    mimeType: "audio/webm",
    buffer: multipartBytes,
  })
  const multipartSigned = alice.waitForResponse(
    (response) =>
      response.url().includes("/api/uploads/sign") &&
      response.request().postData()?.includes('"multipart":true') === true,
  )
  const multipartCreated = alice.waitForResponse((response) =>
    response.url().includes("/api/uploads/multipart/create"),
  )
  const multipartPart = alice.waitForResponse((response) =>
    response.url().includes("/api/uploads/multipart/part"),
  )
  let multipartPartCount = 0
  alice.on("response", (response) => {
    if (response.url().includes("/api/uploads/multipart/part")) multipartPartCount++
  })
  const multipartCompleted = alice.waitForResponse((response) =>
    response.url().includes("/api/uploads/multipart/complete"),
  )
  await alice.getByRole("button", { name: "Send message" }).click()
  const multipartResponses = await Promise.all([
    multipartSigned,
    multipartCreated,
    multipartPart,
    multipartCompleted,
  ])
  const multipartBodies = await Promise.all(multipartResponses.map((response) => response.text()))
  for (const response of multipartResponses) {
    expect(response.ok(), multipartBodies.join("\n")).toBe(true)
  }
  expect(multipartPartCount).toBe(2)
  const encryptedAudio = bob.getByRole("button", { name: /tap to decrypt/i })
  await expect(encryptedAudio).toBeVisible({ timeout: 20_000 })
  await encryptedAudio.click()
  await expect(bob.getByRole("button", { name: "Play voice note" })).toBeVisible({ timeout: 20_000 })

  // Any member can change the chat-wide timer. Ember (not the owner) turns it
  // off; Ash's timer updates live and a system line appears for both of them.
  const bobTimer = bob.getByLabel("Disappearing timer")
  const aliceTimer = alice.getByLabel("Disappearing timer")
  await expect(aliceTimer).toHaveValue(String(24 * 60 * 60 * 1000))
  await bobTimer.selectOption({ label: "Never" })
  await expect(aliceTimer).toHaveValue("0", { timeout: 10_000 })
  await expect(alice.getByText(/turned off disappearing messages/)).toBeVisible({
    timeout: 10_000,
  })
  await expect(bob.getByText(/^You turned off disappearing messages/)).toBeVisible()
  await expect(bobTimer).toHaveValue("0")

  // Mentions, formatting and links. Ember mentions Ash with a link; Ash sees the
  // mention highlighted and must confirm before the link opens.
  await bob
    .getByRole("textbox", { name: "Encrypted message" })
    .fill(`@${PRIVATE_VALUES.username} look **now** https://example.com/page`)
  await bob.keyboard.press("Enter")
  const mention = alice.locator(".msg.mentions-me")
  await expect(mention).toBeVisible()
  await expect(mention.locator("strong")).toHaveText("now")
  await mention.getByRole("link", { name: "https://example.com/page" }).click()
  await expect(alice.getByText("Open this link?")).toBeVisible()
  await expect(alice.getByRole("link", { name: "Open link" })).toHaveAttribute(
    "rel",
    "noopener noreferrer nofollow",
  )
  await alice.getByRole("button", { name: "Cancel" }).click()
  expect(ctx.pages()).toHaveLength(2)

  // Ash (the owner) pins Ember's message; Ember sees the pinned banner.
  await mention.hover()
  await mention.getByRole("button", { name: "Pin message" }).click()
  await expect(bob.locator(".pin-banner")).toContainText("look now")

  // Ash locks the timer; Ember's timer becomes read-only.
  await alice.getByRole("button", { name: "Room actions" }).click()
  await alice.getByRole("button", { name: /timer changes: anyone/i }).click()
  await alice.keyboard.press("Escape")
  await expect(bobTimer).toBeDisabled({ timeout: 10_000 })

  // Prune all visible messages from Ash's side.
  await alice.getByRole("button", { name: "Room actions" }).click()
  await alice.getByRole("button", { name: /clear all visible/i }).click()
  await expect(alice.getByText(PRIVATE_VALUES.message)).toHaveCount(0)
  await expect(bob.getByText(PRIVATE_VALUES.message)).toHaveCount(0, { timeout: 10_000 })

  // Delete the room; Ember sees the deleted state.
  await alice.getByRole("button", { name: "Room actions" }).click()
  await alice.getByRole("button", { name: /delete room/i }).click()
  await alice.getByRole("button", { name: /confirm/i }).click()
  await expect(bob.getByText(/room deleted/i)).toBeVisible({ timeout: 10_000 })
  expect(offenders, offenders.join("\n")).toHaveLength(0)

  await ctx.close()
})
