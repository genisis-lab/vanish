import { defineConfig, devices } from "@playwright/test"

const PORT = Number(process.env.E2E_PORT ?? 8788)
const BASE = process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`

// By default we drive the full Pages + Functions + Durable Object stack via
// `wrangler pages dev`, so the encrypted API and WebSocket realtime are real.
export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: BASE,
    trace: "on-first-retry",
    video: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: `npm run build && npx wrangler pages dev dist --port ${PORT} --compatibility-date=2024-11-06`,
        url: BASE,
        timeout: 180_000,
        reuseExistingServer: !process.env.CI,
      },
})
