# Deploy Vanish to Cloudflare

This guide puts your own copy of Vanish online. If you only want to try it on your computer,
you don't need any of this: run `npm start` as described in the [README](../README.md).

Vanish runs as two pieces on Cloudflare:

- **`vanish-room`**, a Worker that hosts the Durable Objects (one per room, plus a rate
  limiter) and consumes the message-report queue. Its config is `room-worker/wrangler.toml`.
- **`vanish`**, a Pages project that serves the web app and the `/api/*` functions. Its
  config is `wrangler.toml`. It reaches the room Worker by name, so the Worker must be
  deployed **first**.

Both share one R2 bucket, `vanish-media`, which only ever holds encrypted blobs.

## Contents

- [What you need](#what-you-need)
- [First deploy, step by step](#first-deploy-step-by-step)
- [Deploying updates](#deploying-updates)
- [Automatic deploys from GitHub](#automatic-deploys-from-github)
- [Environment variables](#environment-variables)
- [Upgrade notes](#upgrade-notes)

## What you need

- A Cloudflare account with R2 enabled (Dashboard ▸ R2, one time).
- Node.js 22 or newer, and this repository cloned with dependencies installed (`npm install`,
  or just run `npm start` once).

All commands below run from the repository root. `npx wrangler` uses the Wrangler version
pinned in `package.json`, so you don't need to install it globally.

## First deploy, step by step

### 1. Log in to Cloudflare

```bash
npx wrangler login
```

This opens a browser window to authorize Wrangler. Check it worked with `npx wrangler whoami`.

### 2. Create the storage bucket and queues

```bash
npx wrangler r2 bucket create vanish-media
npx wrangler queues create vanish-moderation-reports
npx wrangler queues create vanish-moderation-reports-dlq
```

The room Worker refuses to deploy until the bucket and both queues exist.

> **Optional safety net:** the Durable Object already deletes media on prune,
> burn-after-read, per-message expiry, and room destruction. As belt-and-braces against any
> object the DO ever misses (e.g. an upload whose message post failed), add an R2 lifecycle
> rule that auto-expires objects under the `rooms/` prefix. List current rules with
> `npx wrangler r2 bucket lifecycle list vanish-media`, and add one with
> `npx wrangler r2 bucket lifecycle add vanish-media` (interactive) or via the R2 dashboard
> (Bucket ▸ Settings ▸ Object lifecycle rules). Use an expiry comfortably longer than your
> longest message TTL (e.g. 7 days). Note that rooms or messages set to **Never** auto-delete
> keep their media indefinitely, so a lifecycle rule will remove attachments from those
> messages once it fires; skip the rule (or make it much longer) if you rely on "Never".

### 3. Deploy the room Worker

```bash
npm run worker:deploy
```

This publishes the `vanish-room` Worker that exports `RoomDurableObject` and
`AbuseDurableObject`.

### 4. Create the Pages project and its upload secret

```bash
npx wrangler pages project create vanish --production-branch main
```

Vanish signs short-lived upload links with `UPLOAD_SECRET`. It's a value you make up yourself,
not something Cloudflare issues. Generate a strong one and paste it when prompted:

```bash
openssl rand -base64 32
npx wrangler pages secret put UPLOAD_SECRET --project-name vanish
```

To confirm it is set (this lists names only, never values):

```bash
npx wrangler pages secret list --project-name vanish
```

> Upload endpoints fail closed with `503` when `UPLOAD_SECRET` is not set. There is no
> hard-coded fallback, so configuring the same high-entropy secret for Pages is required.

### 5. Optional: turn on background notifications

Web Push lets Vanish notify people when the app is closed. Generate a VAPID key pair:

```bash
npx web-push generate-vapid-keys
```

Put the keys on the **worker** (it signs and sends the pushes) and the **public key** on
**Pages** (the client subscribes with it). Use the **same** public key in both places; the
private key must **never** be placed on Pages.

```bash
# Worker (Durable Object) — sends notifications
npx wrangler secret put VAPID_PUBLIC_KEY -c room-worker/wrangler.toml
npx wrangler secret put VAPID_PRIVATE_KEY -c room-worker/wrangler.toml
npx wrangler secret put VAPID_SUBJECT -c room-worker/wrangler.toml   # mailto:you@example.com or https://…

# Pages — the client reads the public key to subscribe
npx wrangler pages secret put VAPID_PUBLIC_KEY --project-name vanish
```

> If VAPID is unset, Vanish still works. Background push is simply disabled, and in-app and
> on-screen notifications keep working.

### 6. Build and deploy the web app

```bash
npm run build
npm run pages:deploy
```

Wrangler prints your site's address (`https://vanish-xxx.pages.dev`). The Pages project
binds the `ROOM` and `ABUSE` Durable Object namespaces to the `vanish-room` worker and the
`MEDIA` R2 bucket (see `wrangler.toml`). If you created the project through the dashboard
instead of step 4, confirm those bindings there.

To use your own domain, open the project in the Cloudflare dashboard and add it under
**Custom domains**.

### 7. Smoke test

Open the site, create a room, open the invite link in a second browser or private window,
send a message, upload an image, record a voice note, set a room topic, edit and delete a
message, ban and unban the second participant, prune, and delete the room. To check push,
enable notifications, then confirm messages stay silent while Vanish is visibly open and raise
a generic push only after the app is hidden or closed.

## Deploying updates

After the first deploy, one command ships everything in the right order (room Worker first,
then a fresh build of the web app):

```bash
npm run deploy
```

## Automatic deploys from GitHub

The repository's `Deploy` workflow (`.github/workflows/deploy-pages.yml`) deploys the room
Worker and then Pages every time CI passes on `main`. To use it on your fork, complete the
first deploy above once, then add these under **Settings ▸ Secrets and variables ▸ Actions**:

| Name | Kind | Value |
| --- | --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | Variable | Your account ID (shown by `npx wrangler whoami`) |
| `CLOUDFLARE_API_TOKEN` | Secret | An API token from the "Edit Cloudflare Workers" template, plus **Queues: Edit** and **Pages: Edit** |

The workflow stops early with a clear error if either one is missing, and it only ever
deploys the current tip of `main`.

## Environment variables

| Variable | Where | Purpose |
| --- | --- | --- |
| `UPLOAD_SECRET` | Pages (secret) | Signs short-lived, object-scoped R2 upload capabilities |
| `VAPID_PUBLIC_KEY` | Worker + Pages (secret) | Web Push public key; the client subscribes with it (same value in both places) |
| `VAPID_PRIVATE_KEY` | Worker (secret) | Web Push private key that signs push messages — never place it on Pages |
| `VAPID_SUBJECT` | Worker (secret) | VAPID contact URI (`mailto:…` or `https://…`) |
| `VITE_APP_NAME` | Build-time (optional) | Override the app name |
| `VITE_IPA_DOWNLOAD_URL` | Build-time (optional) | If set, shows the “Install the app” prompt and a Download IPA button |

Build-time variables go in a `.env` file (copy `.env.example`). Never commit real secrets;
`.env`, `.env.*` and `.dev.vars` are git-ignored.

Cloudflare Web Analytics is enabled at the Pages/zone level. The production CSP allows only
Cloudflare's documented beacon script and reporting endpoint; no build-time analytics token is
required.

## Upgrade notes

- **Always deploy the room Worker before Pages.** New API routes forward operations that an
  older Worker doesn't understand. `npm run deploy` and the GitHub workflow both do this for
  you.
- **Read-once consumption.** The client calls authenticated `POST /api/messages/read` and
  `POST /api/messages/consume` endpoints. Existing clients may continue listing messages, but
  only updated clients use explicit read-once consumption. Old persisted read-once messages
  receive a maximum lifetime from the room's default timer when their Durable Object is
  loaded again. This does not scan dormant rooms globally.

For iOS and Android builds that wrap the deployed site, see [NATIVE.md](NATIVE.md).
