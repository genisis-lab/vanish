# Vanish — Encrypted Anonymous Chat

> Anonymous chat that vanishes without a trace.

Vanish is a Cloudflare-native, end-to-end encrypted, anonymous group chat. There are no
accounts, emails, phone numbers, or profiles. You pick a display name, create a room, and
share a secret invite link. Everything — message text, usernames, captions, filenames, and
media — is encrypted in your browser **before** it ever reaches the network. The server only
ever sees opaque ciphertext plus the minimum operational metadata required to route and expire
it.

---

## How the encryption works

- The invite key is `anonchat:v1:<roomId>.<secret>`, where `roomId` is 16 random bytes and
  `secret` is 32 random bytes (both base64url). The **secret never leaves the browser** and is
  never sent to the server.
- On join, the browser uses **HKDF-SHA-256** to derive several independent keys from the
  secret:
  - `msgKey` — AES-GCM-256 for message envelopes (text, usernames, reactions)
  - `mediaKey` — AES-GCM-256 for media bytes, filenames, captions, and manifests
  - `channelKey` — for realtime channel framing
  - `accessProof` / `accessProofHash` — a proof the server can verify to gate access **without**
    being able to derive the secret or decrypt anything
  - `safetyNumber` — a human-verifiable fingerprint of the room key
- Every payload is sealed as `[version][iv(12)][ciphertext]` (base64url) with AES-GCM and a
  purpose-bound AAD (`<roomId>:msg`, `:media`, `:react`, `:channel`). The `msgKey`/`mediaKey`
  are non-extractable `CryptoKey`s.
- Plaintext is padded to coarse size buckets before encryption (messages to 256-byte buckets,
  media to power-of-four byte buckets) so ciphertext length leaks far less about content.
- The server stores only: room id, an access-verifier hash, invite expiry, created/deleted
  timestamps, encrypted message envelopes, encrypted media object paths + sizes, and
  per-message expiry. **It has no key material and cannot decrypt anything.** Cloudflare may
  still process transport metadata such as IP addresses, timestamps, room IDs, and object
  sizes.

---

## Architecture

| Layer | Tech |
| --- | --- |
| UI | React + Vite, deployed to **Cloudflare Pages** |
| API | **Pages Functions** under `functions/api/*` |
| Coordination + realtime | **Durable Object** (`RoomDurableObject`) in the companion `room-worker/` |
| Encrypted media | **R2** bucket `vanish-media` (encrypted blobs only) |

The Durable Object owns each room's state, fans out realtime WebSocket frames, and runs
`alarm()`-driven sweeps to delete expired messages and orphaned media. Pages Functions are thin
auth/validation handlers that forward to the DO via a service binding.

```
browser ──(ciphertext)──▶ Pages Functions ──(service binding)──▶ Room Durable Object
   │                                                                   │
   └── decrypt locally ◀── encrypted blobs ◀──────── R2 (vanish-media) ┘
```

---

## Project layout

```
shared/        Crypto, invite, room-core logic shared by client + server (framework-free)
functions/     Cloudflare Pages Functions (the HTTP API + WebSocket entry)
room-worker/   Companion Worker hosting the Room Durable Object + R2 binding
src/           React + Vite front-end (lib/ logic, components/ UI, styles/)
public/        PWA manifest, service worker, icons, _headers (CSP), _routes.json
tests/         unit (vitest) · manual (tsx verify) · e2e (playwright)
```

---

## Local development

```bash
npm install

# Front-end only (Vite dev server)
npm run dev

# Full stack locally (Pages + Functions + DO + R2 emulation)
npm run worker:dev      # terminal 1 — runs the room-worker Durable Object
npm run pages:dev       # terminal 2 — runs Pages + Functions, bound to the worker
```

Copy `.env.example` to `.env` and adjust as needed. All build-time front-end vars are optional.

---

## Testing

```bash
npm test            # unit tests (crypto, invite, room-core) via vitest
npm run test:e2e    # end-to-end browser tests via Playwright
npm run typecheck   # tsc across shared / functions / worker / front-end
```

What the suites cover:

- **Crypto** — the same key round-trips; a wrong key fails to decrypt; a tampered ciphertext
  fails the GCM auth tag; message / media / proof keys are independent.
- **API** — invalid invites are denied; expired invites are blocked from joining (but existing
  data is preserved); rejoin works; multiple participants can join; prune and delete require a
  valid access proof.
- **E2E** — two browser contexts create + join a room, exchange live text, upload an
  image/video, decrypt and download it, prune messages, and delete the room.
- **Privacy** — assertions that no plaintext message text, usernames, filenames, or media bytes
  are ever present in server-bound payloads.

> Note: a sandbox without a package registry cannot install dev dependencies; in that
> environment the crypto/room core was verified directly with `tsx tests/manual/verify.ts`
> (27/27 checks). On any normal machine, `npm install` then the commands above run the full
> suites.

---

## Deployment (Cloudflare)

> Deploy the Durable Object Worker **first** — Pages binds to it by script name.

1. **Install the CLI and log in**
   ```bash
   npm install
   npx wrangler login
   ```
2. **Create the R2 bucket** (shared by Pages + worker)
   ```bash
   npx wrangler r2 bucket create vanish-media
   ```
3. **Deploy the Room Durable Object worker**
   ```bash
   npm run worker:deploy   # publishes the "vanish-room" worker that exports RoomDurableObject
   ```
4. **Set the shared upload secret** (used to sign R2 upload/download tokens) on **both** the
   worker and the Pages project. This is a value you generate yourself (e.g.
   `openssl rand -base64 32`) — it is not issued by Cloudflare; just use the same string in
   both commands:
   ```bash
   npx wrangler secret put UPLOAD_SECRET                       # for the worker
   npx wrangler pages secret put UPLOAD_SECRET --project-name vanish   # for Pages
   ```
   To confirm it is already set (names only, never values):
   ```bash
   npx wrangler secret list
   npx wrangler pages secret list --project-name vanish
   ```
5. **Build and deploy Pages**
   ```bash
   npm run build
   npm run pages:deploy    # wrangler pages deploy dist --project-name vanish
   ```
   The Pages project binds the `ROOM` Durable Object namespace to the `vanish-room` worker and
   binds the `MEDIA` R2 bucket (see `wrangler.toml`). Confirm both bindings in the dashboard if
   you created the project through the UI.
6. **Smoke test** the live deploy: open the site, create a room, open the invite link in a
   second browser/profile, send a message, upload an image, prune, and delete.

### Environment variables

| Variable | Where | Purpose |
| --- | --- | --- |
| `UPLOAD_SECRET` | Worker + Pages (secret) | Signs short-lived R2 upload/download tokens |
| `VITE_APP_NAME` | Build-time (optional) | Override the app name |
| `VITE_CF_ANALYTICS_TOKEN` | Build-time (optional) | Cloudflare Web Analytics token |
| `VITE_IPA_DOWNLOAD_URL` | Build-time (optional) | If set, shows the “Install the app” prompt and a Download IPA button |

---

## Security & privacy summary

- Messages, usernames, captions, filenames, and media are encrypted in your browser before
  upload. The server cannot read them.
- Plaintext is size-padded before encryption, so ciphertext and stored object sizes reveal
  little about message or file length.
- Static front-end assets are protected with **Subresource Integrity** (SHA-384 hashes injected
  at build time), so your browser refuses to run any script or stylesheet whose bytes have been
  altered in transit or at the edge.
- Vanish is **anonymous**: no account, email, phone, or profile is ever collected.
- Keys live only in the invite link and your browser. **If you lose the link, the room is
  unrecoverable** — there is no reset, by design.
- Anyone holding the invite key can join and decrypt, so share it only with people you trust.
- Messages auto-delete on a per-room schedule (default 24 hours), with optional
  burn-after-read; the whole room can also be set to self-destruct, and you can manually prune
  or delete the entire room at any time.
- Cloudflare may process transport metadata (IP addresses, timestamps, room IDs, object sizes)
  to operate the service.
- Vanish uses strong, modern, secure-by-default cryptography, but it is **not** intended for
  legal, military, or classified use.
