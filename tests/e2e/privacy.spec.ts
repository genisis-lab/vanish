import { test, expect } from "@playwright/test"

test("an invalid invite is rejected", async ({ page }) => {
  const unknown = `anonchat:v1:${"A".repeat(22)}.${"A".repeat(43)}`
  await page.goto("/")
  await page.getByRole("tab", { name: /join with key/i }).click()
  await page.getByLabel(/invite key or link/i).fill(unknown)
  await page.getByRole("button", { name: /continue/i }).click()
  await expect(page.getByText(/invalid|couldn.t|not valid/i)).toBeVisible()
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
