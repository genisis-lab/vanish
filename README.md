# Vanish — Encrypted Anonymous Chat

> Anonymous chat that vanishes without a trace.

Vanish is a Cloudflare-native, end-to-end encrypted, anonymous group chat. There are no
accounts, emails, phone numbers, or profiles. You pick a display name, create a room, and
share a secret invite link. Everything — message text, usernames, captions, filenames, and
media — is encrypted in your browser **before** it ever reaches the network. The server only
ever sees opaque ciphertext plus the minimum operational metadata required to route and expire
it.

---

## Features

- **Anonymous, instant rooms** — no account, email, or phone. Pick a display name, create a
  room, and share the secret invite link or QR code.
- **End-to-end encryption** — message text, usernames, captions, filenames, and media are
  encrypted in your browser before they touch the network (AES-GCM-256, keys derived with
  HKDF-SHA-256).
- **Per-sender signatures** — every message is signed with an ephemeral Ed25519 key, with
  trust-on-first-use pinning, so holding the room key alone can't forge messages as another
  member.
- **Encrypted media** — share images and video; bytes, filenames, and captions are encrypted
  client-side and stored as opaque R2 blobs. Drag-and-drop and clipboard paste are supported.
- **Replies & reactions** — quote any message and react with emoji; reactions are encrypted
  too.
- **Realtime presence** — live typing indicators, participant counts, and “seen” markers over
  WebSockets, with an automatic polling fallback.
- **Disappearing messages** — per-message timers, optional burn-after-read, and an optional
  whole-room self-destruct.
- **Background notifications** — Web Push wakes you for new messages even when Vanish is fully
  closed, across every room you've joined (see below).
- **Installable PWA** — runs offline as an app shell and prompts you to refresh when a new
  build ships.
- **Privacy guards** — a privacy blur veils the conversation when you switch away, plus a
  one-tap “panic” wipe-and-leave.
- **Stays on your device** — optionally remember a room in an encrypted local vault to rejoin
  after a refresh, change your nickname mid-room, and export a local transcript.

### Notifications across rooms

Notifications follow you across every room you've joined, not just the one on screen:

- A message in the room you're **currently viewing** is handled by the in-app UI — no
  redundant system notification.
- A message in a **different room you've joined** (or while Vanish is backgrounded or fully
  closed) still raises a background push — even when the app is open on another room.
- Push payloads are **content-free** (`{ "t": "msg", "room": <id> }`). The server can't read
  your messages, so the notification is a generic “new encrypted message” ping that opens the
  app to decrypt locally.
- Toggle notifications per session with the bell icon. Turning them off unsubscribes this
  browser, and the server prunes dead subscriptions automatically. Background push requires
  VAPID keys to be configured at deploy time (see Deployment); without them, in-app and
  on-screen notifications still work.

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
- Each device also generates an ephemeral **Ed25519 signing keypair** when it joins. This key
  is deliberately **not** derived from the room secret — deriving it from shared material would
  let any member forge another member's signature. The device signs every message, and the
  signature plus its public key travel **inside** the encrypted envelope. Recipients verify the
  signature, so merely holding the shared room key is **not** enough to forge a message
  attributed to another sender. The UI flags any message whose signature fails to verify or
  whose sender's signing key changes mid-session (trust-on-first-use pinning). If a browser
  lacks WebCrypto Ed25519, the app gracefully falls back to sending unsigned messages.
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
| Background push | **Web Push** (VAPID) fanned out from the Durable Object |

The Durable Object owns each room's state, fans out realtime WebSocket frames, sends background
Web Push pings to closed/asleep devices, and runs `alarm()`-driven sweeps to delete expired
messages and orphaned media. Pages Functions are thin auth/validation handlers that forward to
the DO via a service binding.

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
   > **Optional safety net:** the Durable Object already deletes media on prune,
   > burn-after-read, per-message expiry, and room destruction. As belt-and-braces against any
   > object the DO ever misses (e.g. an upload whose message post failed), add an R2 lifecycle
   > rule that auto-expires objects under the `rooms/` prefix. List current rules with
   > `npx wrangler r2 bucket lifecycle list vanish-media`, and add one with
   > `npx wrangler r2 bucket lifecycle add vanish-media` (interactive) or via the R2 dashboard
   > (Bucket ▸ Settings ▸ Object lifecycle rules). Use an expiry comfortably longer than your
   > longest message TTL (e.g. 7 days).
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
   > If `UPLOAD_SECRET` is **not** set, the worker falls back to a hard-coded development secret
   > (`vanish-dev-upload-secret-change-me`). That makes upload/download tokens forgeable, so
   > setting a real secret in production is required, not optional.
5. **Enable background notifications** (optional, recommended) — generate a VAPID key pair for
   Web Push:
   ```bash
   npx web-push generate-vapid-keys
   ```
   Put the keys on the **worker** (it signs and sends the pushes) and the **public key** on
   **Pages** (the client subscribes with it). Use the **same** public key in both places; the
   private key must **never** be placed on Pages.
   ```bash
   # Worker (Durable Object) — sends notifications
   npx wrangler secret put VAPID_PUBLIC_KEY
   npx wrangler secret put VAPID_PRIVATE_KEY
   npx wrangler secret put VAPID_SUBJECT      # a contact URI: mailto:you@example.com or https://…

   # Pages — the client reads the public key to subscribe
   npx wrangler pages secret put VAPID_PUBLIC_KEY --project-name vanish
   ```
   > If VAPID is unset, Vanish still works — background push fan-out is simply disabled, and
   > in-app plus on-screen notifications continue to function.
6. **Build and deploy Pages**
   ```bash
   npm run build
   npm run pages:deploy    # wrangler pages deploy dist --project-name vanish
   ```
   The Pages project binds the `ROOM` Durable Object namespace to the `vanish-room` worker and
   binds the `MEDIA` R2 bucket (see `wrangler.toml`). Confirm both bindings in the dashboard if
   you created the project through the UI.
7. **Smoke test** the live deploy: open the site, create a room, open the invite link in a
   second browser/profile, send a message, upload an image, prune, and delete. To check push,
   enable notifications in two rooms and confirm a message in the room you're *not* viewing
   raises a notification.

### Environment variables

| Variable | Where | Purpose |
| --- | --- | --- |
| `UPLOAD_SECRET` | Worker + Pages (secret) | Signs short-lived R2 upload/download tokens |
| `VAPID_PUBLIC_KEY` | Worker + Pages (secret) | Web Push public key; the client subscribes with it (same value in both places) |
| `VAPID_PRIVATE_KEY` | Worker (secret) | Web Push private key that signs push messages — never place it on Pages |
| `VAPID_SUBJECT` | Worker (secret) | VAPID contact URI (`mailto:…` or `https://…`) |
| `VITE_APP_NAME` | Build-time (optional) | Override the app name |
| `VITE_CF_ANALYTICS_TOKEN` | Build-time (optional) | Cloudflare Web Analytics token |
| `VITE_IPA_DOWNLOAD_URL` | Build-time (optional) | If set, shows the “Install the app” prompt and a Download IPA button |

---

## Security & privacy summary

- Messages, usernames, captions, filenames, and media are encrypted in your browser before
  upload. The server cannot read them.
- Each message is **signed with a per-sender Ed25519 key**, so other participants are warned if
  a message can't be verified or a sender's signing key changes — holding the room key alone
  does not let someone forge messages as another participant.
- Plaintext is size-padded before encryption, so ciphertext and stored object sizes reveal
  little about message or file length.
- Background push notifications are **content-free** — they carry only a room id, never message
  text — and the device decrypts locally after you open the app.
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

---

## Threat model

Vanish is built for **anonymous, ephemeral, end-to-end-encrypted conversations among people who
share an invite link out-of-band**. Being explicit about what that does and does not cover:

### What Vanish protects against

- **The server / host reading content.** Pages Functions, the Durable Object, and R2 only ever
  store ciphertext and operational metadata. They hold no key material and cannot decrypt
  messages, usernames, captions, filenames, or media — even if fully compromised.
- **Network eavesdroppers.** All content is AES-GCM-256 encrypted in the browser before it
  touches the network, underneath TLS.
- **Tampering with stored or in-transit ciphertext.** AES-GCM authentication tags make any
  modified envelope fail decryption rather than yield altered plaintext.
- **Impersonation by another room member.** Per-sender Ed25519 signatures plus trust-on-first-
  use pinning mean a participant (or anyone who merely holds the invite key) cannot forge a
  message attributed to a different sender without the UI flagging it.
- **Tampered front-end delivery.** Subresource Integrity (SHA-384) makes the browser refuse any
  script or stylesheet whose bytes were altered at the edge or in transit.
- **Indefinite retention.** Messages auto-expire on a per-room schedule, support
  burn-after-read, and the whole room can self-destruct; deletion removes envelopes and the
  associated R2 objects.
- **Content-length leakage.** Plaintext is padded to coarse size buckets before encryption.

### What Vanish does NOT protect against

- **A malicious or careless participant.** Anyone you give the invite key to can read
  everything, screenshot it, copy it, or re-share the key. Signing proves *who said what among
  current members* — it does not stop an authorized member from leaking.
- **A compromised device or browser.** Keys live in your browser; malware, a hostile extension,
  or someone with your unlocked device can read plaintext. Vanish is only as trustworthy as the
  endpoints.
- **Metadata.** Cloudflare necessarily processes transport metadata — IP addresses, timestamps,
  room IDs, request sizes, and object sizes. Vanish does not use Tor-style mix routing; it is
  not designed to hide *that* you are talking or *with whom* at the network level.
- **Forward secrecy (not yet).** The room key is static for the life of the invite, so a future
  compromise of the invite secret could decrypt previously captured ciphertext. Key ratcheting
  is a planned enhancement.
- **Lost keys.** The secret lives only in the invite link and your browser. Lose the link and
  the room is unrecoverable by design — there is no reset or recovery.
- **Traffic analysis.** Presence counts and message timing are observable to the server.
- **Legal, military, or classified use.** Vanish uses strong, modern, secure-by-default
  cryptography, but it has not been independently audited and is not intended for high-stakes
  adversarial use.

### Trust assumptions

- You trust the people you share the invite key with.
- You trust the device and browser you run Vanish in.
- You trust that the code served to your browser is authentic. Subresource Integrity and a
  strict CSP help, but you are ultimately trusting the deployment and Cloudflare's edge.
- When it matters, you compare the **safety number** out-of-band and heed the per-sender
  key-change warnings.

---

## License

Vanish is released under the [MIT License](./LICENSE).
