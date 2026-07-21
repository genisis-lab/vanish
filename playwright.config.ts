import { defineConfig, devices } from "@playwright/test"

const PORT = Number(process.env.E2E_PORT ?? 8788)
const WORKER_PORT = Number(process.env.E2E_WORKER_PORT ?? 8797)
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
    serviceWorkers: "block",
    trace: "on-first-retry",
    video: "retain-on-failure",
  },
  // The local Pages emulator can stop accepting new document navigations once
  // the Durable Object test holds long-lived WebSockets. Run navigation/API
  // preflight coverage first, then make the realtime chat flow the final phase.
  projects: [
    {
      name: "preflight",
      testMatch: /privacy\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "chromium",
      testMatch: /chat\.spec\.ts/,
      dependencies: ["preflight"],
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : [
        {
          command: `npm run worker:dev -- --port ${WORKER_PORT}`,
          url: `http://localhost:${WORKER_PORT}/health`,
          timeout: 180_000,
          reuseExistingServer: !process.env.CI,
        },
        {
          command: `npm run build && npx wrangler pages dev dist --port ${PORT} --binding E2E_MODE=1 --binding UPLOAD_SECRET=e2e-only-upload-secret`,
          url: BASE,
          timeout: 180_000,
          reuseExistingServer: !process.env.CI,
          env: {
            UPLOAD_SECRET: process.env.UPLOAD_SECRET ?? "e2e-only-upload-secret",
            E2E_MODE: "1",
            VITE_DISABLE_SW: "1",
          },
        },
      ],
})
