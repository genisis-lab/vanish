import { test, expect, type APIRequestContext } from "@playwright/test"
import { createInvite } from "../../shared/invite"
import { deriveKeys, randomBytes, toBase64Url } from "../../shared/crypto"
import { MEDIA_ENCRYPTED_CHUNK_BYTES } from "../../shared/constants"

async function createApiSession(request: APIRequestContext) {
  const invite = createInvite()
  const keys = await deriveKeys(invite.secret, invite.roomId)
  const participantId = toBase64Url(randomBytes(12))
  const participantProof = toBase64Url(randomBytes(32))
  const created = await request.post("/api/rooms", {
    data: { roomId: invite.roomId, accessProofHash: keys.accessProofHash, inviteExpiry: "never" },
  })
  expect(created.status(), await created.text()).toBe(200)
  const joined = await request.post("/api/session", {
    data: { roomId: invite.roomId, accessProof: keys.accessProof, participantId, participantProof },
  })
  expect(joined.status(), await joined.text()).toBe(200)
  return { invite, keys, participantId, participantProof }
}

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

test("security boundaries reject oversized, forged, incomplete, and SSRF-shaped requests", async ({ request }) => {
  const oversized = await request.post("/api/rooms", {
    data: JSON.stringify({ padding: "x".repeat(300 * 1024) }),
    headers: { "content-type": "application/json" },
  })
  expect(oversized.status()).toBe(400)

  const session = await createApiSession(request)
  const conflictingCreate = await request.post("/api/rooms", {
    data: {
      roomId: session.invite.roomId,
      accessProofHash: "A".repeat(43),
      inviteExpiry: "never",
    },
  })
  expect(conflictingCreate.status()).toBe(409)

  const malformedProof = await request.post("/api/session", {
    data: {
      roomId: session.invite.roomId,
      accessProof: "not-base64url-proof",
      participantId: session.participantId,
      participantProof: session.participantProof,
    },
  })
  expect(malformedProof.status()).toBe(403)

  const spoofedSystemMessage = await request.post("/api/messages", {
    data: {
      roomId: session.invite.roomId,
      accessProof: session.keys.accessProof,
      participantProof: session.participantProof,
      message: {
        id: toBase64Url(randomBytes(12)),
        participantId: session.participantId,
        envelope: "opaque-system-notice",
        kind: "system",
      },
    },
  })
  expect(spoofedSystemMessage.status()).toBe(400)

  const p256dh = new Uint8Array(65)
  p256dh[0] = 4
  const push = await request.post("/api/push/subscribe", {
    data: {
      roomId: session.invite.roomId,
      accessProof: session.keys.accessProof,
      participantId: session.participantId,
      participantProof: session.participantProof,
      subscription: {
        endpoint: "https://attacker.example/push-target",
        keys: { p256dh: toBase64Url(p256dh), auth: toBase64Url(new Uint8Array(16)) },
      },
    },
  })
  expect(push.status()).toBe(400)

  const signed = await request.post("/api/uploads/sign", {
    data: {
      roomId: session.invite.roomId,
      accessProof: session.keys.accessProof,
      participantId: session.participantId,
      participantProof: session.participantProof,
      size: MEDIA_ENCRYPTED_CHUNK_BYTES,
      previewKind: "image",
      multipart: true,
    },
  })
  expect(signed.status(), await signed.text()).toBe(200)
  const capability = await signed.json()
  const headers = {
    "x-vanish-token": capability.token as string,
    "x-vanish-object": capability.objectKey as string,
    "x-vanish-size": String(capability.size),
    "x-vanish-expires": String(capability.expiresAt),
  }
  const started = await request.post("/api/uploads/multipart/create", { headers })
  expect(started.status(), await started.text()).toBe(200)
  const { uploadId } = await started.json()

  const prematureMessage = await request.post("/api/messages", {
    data: {
      roomId: session.invite.roomId,
      accessProof: session.keys.accessProof,
      participantProof: session.participantProof,
      message: {
        id: toBase64Url(randomBytes(12)),
        participantId: session.participantId,
        envelope: "opaque",
        kind: "media",
        media: [{
          objectKey: capability.objectKey,
          size: capability.size,
          previewKind: "image",
        }],
      },
    },
  })
  expect(prematureMessage.status()).toBe(409)
  await request.delete("/api/uploads/multipart/abort", {
    headers: { ...headers, "x-vanish-upload-id": uploadId as string },
  })

  const smallSigned = await request.post("/api/uploads/sign", {
    data: {
      roomId: session.invite.roomId,
      accessProof: session.keys.accessProof,
      participantId: session.participantId,
      participantProof: session.participantProof,
      size: 31,
      previewKind: "image",
    },
  })
  expect(smallSigned.status(), await smallSigned.text()).toBe(200)
  const small = await smallSigned.json()
  const query = new URLSearchParams({
    token: small.token as string,
    key: small.objectKey as string,
    size: String(small.size),
    exp: String(small.expiresAt),
  })
  const queryCapability = await request.post(`/api/uploads/put?${query}`, {
    data: Buffer.alloc(31),
    headers: { "content-type": "application/octet-stream" },
  })
  expect(queryCapability.status()).toBe(400)

  const mismatchedLength = await request.post("/api/uploads/put", {
    data: Buffer.alloc(32),
    headers: {
      "content-type": "application/octet-stream",
      "x-vanish-token": small.token as string,
      "x-vanish-object": small.objectKey as string,
      "x-vanish-size": String(small.size),
      "x-vanish-expires": String(small.expiresAt),
    },
  })
  expect(mismatchedLength.status()).toBe(400)

  const directWorker = await request.post(
    `http://localhost:${process.env.E2E_WORKER_PORT ?? "8797"}/room/${session.invite.roomId}/create`,
    { data: { roomId: session.invite.roomId, accessProofHash: session.keys.accessProofHash } },
  )
  expect(directWorker.status()).toBe(404)
})
