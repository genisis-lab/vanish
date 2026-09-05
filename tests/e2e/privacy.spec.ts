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

test("security boundaries reject oversized, forged, incomplete, and SSRF-shaped requests", async ({
  request,
}) => {
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
        media: [
          {
            objectKey: capability.objectKey,
            size: capability.size,
            previewKind: "image",
          },
        ],
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

test("read-once media survives listing and is removed only by an authenticated consumption receipt", async ({
  request,
}) => {
  const sender = await createApiSession(request)
  const reader = {
    roomId: sender.invite.roomId,
    accessProof: sender.keys.accessProof,
    participantId: toBase64Url(randomBytes(12)),
    participantProof: toBase64Url(randomBytes(32)),
  }
  expect((await request.post("/api/session", { data: reader })).status()).toBe(200)
  const auth = {
    roomId: sender.invite.roomId,
    accessProof: sender.keys.accessProof,
    participantId: sender.participantId,
    participantProof: sender.participantProof,
  }
  const signed = await request.post("/api/uploads/sign", {
    data: { ...auth, size: 64, previewKind: "image" },
  })
  expect(signed.status(), await signed.text()).toBe(200)
  const sign = await signed.json()
  expect(
    (
      await request.post("/api/uploads/put", {
        data: Buffer.alloc(64, 7),
        headers: {
          "content-type": "application/octet-stream",
          "x-vanish-token": sign.token,
          "x-vanish-object": sign.objectKey,
          "x-vanish-size": String(sign.size),
          "x-vanish-expires": String(sign.expiresAt),
        },
      })
    ).status(),
  ).toBe(200)
  const id = toBase64Url(randomBytes(12))
  const posted = await request.post("/api/messages", {
    data: {
      ...auth,
      message: {
        id,
        participantId: sender.participantId,
        kind: "media",
        envelope: "opaque",
        burn: true,
        ttlMs: 60_000,
        media: [{ objectKey: sign.objectKey, size: sign.size, previewKind: "image" }],
      },
    },
  })
  expect(posted.status(), await posted.text()).toBe(200)
  expect((await posted.json()).message.expiresAt).toBeGreaterThan(Date.now())
  const listed = await request.post("/api/messages/list", {
    data: { ...reader, markReadFor: reader.participantId },
  })
  expect((await listed.json()).messages.map((m: { id: string }) => m.id)).toContain(id)
  const download = () =>
    request.post("/api/uploads/download", { data: { ...reader, objectKey: sign.objectKey } })
  expect((await download()).status()).toBe(200)
  const forged = await request.post("/api/messages/consume", {
    data: { ...reader, participantProof: auth.participantProof, messageIds: [id] },
  })
  expect(forged.status()).toBe(403)
  const authorRead = await request.post("/api/messages/consume", {
    data: { ...auth, messageIds: [id] },
  })
  expect((await authorRead.json()).consumedIds).toEqual([])
  const consumed = await request.post("/api/messages/consume", {
    data: { ...reader, messageIds: [id] },
  })
  expect(consumed.status(), await consumed.text()).toBe(200)
  expect((await consumed.json()).consumedIds).toEqual([id])
  expect((await download()).status()).toBe(404)
  expect(
    (await (await request.post("/api/messages/list", { data: auth })).json()).messages,
  ).toEqual([])
})

test("read receipts identify visible messages and do not consume unopened messages", async ({
  request,
}) => {
  const sender = await createApiSession(request)
  const auth = {
    roomId: sender.invite.roomId,
    accessProof: sender.keys.accessProof,
    participantId: sender.participantId,
    participantProof: sender.participantProof,
  }
  const reader = {
    ...auth,
    participantId: toBase64Url(randomBytes(12)),
    participantProof: toBase64Url(randomBytes(32)),
  }
  await request.post("/api/session", { data: reader })
  const ids = [
    toBase64Url(randomBytes(12)),
    toBase64Url(randomBytes(12)),
    toBase64Url(randomBytes(12)),
  ]
  for (let i = 0; i < ids.length; i++) {
    const posted = await request.post("/api/messages", {
      data: {
        ...auth,
        message: {
          id: ids[i],
          participantId: sender.participantId,
          kind: "text",
          envelope: "opaque",
          burn: i === 2,
          ttlMs: 60_000,
        },
      },
    })
    expect(posted.status()).toBe(200)
  }
  const receipt = await request.post("/api/messages/read", {
    data: { ...reader, messageIds: [ids[1], ids[2]] },
  })
  expect(receipt.status()).toBe(200)
  const snapshot = await (
    await request.post("/api/messages/list", {
      data: { ...auth, signalsSince: Date.now() - 10_000 },
    })
  ).json()
  const seen = snapshot.signals.filter((f: { t: string }) => f.t === "seen")
  expect(seen.at(-1).messageIds).toEqual([ids[1]])
  expect(snapshot.messages.map((m: { id: string }) => m.id)).toEqual(ids)
  expect(
    (
      await request.post("/api/messages/read", {
        data: { ...reader, participantProof: auth.participantProof, messageIds: [ids[0]] },
      })
    ).status(),
  ).toBe(403)
})
