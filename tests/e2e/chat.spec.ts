import { test, expect, type Page } from "@playwright/test"
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

test("two anonymous users chat, share media, prune, and delete", async ({ browser }) => {
  const ctx = await browser.newContext({ serviceWorkers: "block" })
  const alice = await ctx.newPage()
  const bobPage = await ctx.newPage()
  await Promise.all([alice.goto("/"), bobPage.goto("/")])

  const inviteUrl = await createRoom(alice, "Ash")
  const bob = await joinRoom(bobPage, inviteUrl, "Ember")

  // Live text from Ash arrives for Ember.
  await alice.getByRole("textbox", { name: "Encrypted message" }).fill("hello from ash")
  await alice.keyboard.press("Enter")
  await expect(bob.getByText("hello from ash")).toBeVisible()

  // Live text back from Ember arrives for Ash.
  await bob.getByRole("textbox", { name: "Encrypted message" }).fill("hi ember here")
  await bob.keyboard.press("Enter")
  await expect(alice.getByText("hi ember here")).toBeVisible()

  // Ash uploads an image; Ember can decrypt + view it.
  const tmp = path.join(os.tmpdir(), "vanish-e2e.png")
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

  // Prune all visible messages from Ash's side.
  await alice.getByRole("button", { name: "Room actions" }).click()
  await alice.getByRole("button", { name: /clear all visible/i }).click()
  await expect(alice.getByText("hello from ash")).toHaveCount(0)
  await expect(bob.getByText("hello from ash")).toHaveCount(0, { timeout: 10_000 })

  // Delete the room; Ember sees the deleted state.
  await alice.getByRole("button", { name: "Room actions" }).click()
  await alice.getByRole("button", { name: /delete room/i }).click()
  await alice.getByRole("button", { name: /confirm/i }).click()
  await expect(bob.getByText(/room deleted/i)).toBeVisible({ timeout: 10_000 })

  await ctx.close()
})

test("an invalid invite is rejected", async ({ page }) => {
  const unknown = `anonchat:v1:${"A".repeat(22)}.${"A".repeat(43)}`
  await page.goto("/")
  await page.getByRole("tab", { name: /join with key/i }).click()
  await page.getByLabel(/invite key or link/i).fill(unknown)
  await page.getByRole("button", { name: /continue/i }).click()
  await expect(page.getByText(/invalid|couldn.t|not valid/i)).toBeVisible()
})
