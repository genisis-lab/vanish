// Dependency-free verification of the security-critical core, runnable with tsx
// (no npm install needed). Mirrors the assertions in the Vitest suites so the
// crypto + room logic can be checked in any environment.
//
//   npx tsx tests/manual/verify.ts

import {
  decryptBytes,
  decryptString,
  deriveKeys,
  encryptBytes,
  encryptString,
  hashAccessProof,
  opaqueReactionId,
} from "../../shared/crypto"
import { createInvite, parseInviteKey, buildInviteUrl, parseInviteFromUrl } from "../../shared/invite"
import { padText, packAndPadMedia, unpackMedia, mediaBucket } from "../../shared/padding"
import { RoomCore } from "../../shared/roomCore"

let passed = 0
let failed = 0
function ok(name: string, cond: boolean) {
  if (cond) {
    passed++
    console.log(`  \u2713 ${name}`)
  } else {
    failed++
    console.error(`  \u2717 ${name}`)
  }
}
async function throws(name: string, fn: () => Promise<unknown>) {
  try {
    await fn()
    failed++
    console.error(`  \u2717 ${name} (expected throw)`)
  } catch {
    passed++
    console.log(`  \u2713 ${name}`)
  }
}

async function main() {
  console.log("crypto")
  const invite = createInvite()
  const keys = await deriveKeys(invite.secret, invite.roomId)

  // same key decrypts
  const env = await encryptString(keys.msgKey, "hello vanish", "aad")
  ok("same key decrypts", (await decryptString(keys.msgKey, env, "aad")) === "hello vanish")

  // wrong key fails
  const other = await deriveKeys(createInvite().secret, invite.roomId)
  await throws("wrong key fails", () => decryptString(other.msgKey, env, "aad"))

  // tampered ciphertext fails
  const raw = await encryptBytes(keys.msgKey, new TextEncoder().encode("x"))
  raw[raw.length - 1] ^= 0xff
  await throws("tampered ciphertext fails", () => decryptBytes(keys.msgKey, raw))

  // wrong AAD fails
  await throws("wrong AAD fails", () => decryptString(keys.msgKey, env, "different-aad"))

  // derived keys separated by purpose
  const msgRaw = await crypto.subtle.exportKey("raw", keys.msgKey).catch(() => null)
  ok("msg/media keys are non-extractable", msgRaw === null)
  const mEnv = await encryptString(keys.mediaKey, "media-secret")
  await throws("media key cannot read msg envelope", () => decryptString(keys.msgKey, mEnv))
  ok("access proof != channel bits", keys.accessProof !== Buffer.from(keys.channelKey).toString("hex"))
  ok("safety number formatted", /^(\d{5} ){11}\d{5}$/.test(keys.safetyNumber))

  // access proof hash is stable + matches server-side hash
  ok("accessProofHash stable", (await hashAccessProof(keys.accessProof)) === keys.accessProofHash)
  ok("two rooms derive different proofs", keys.accessProof !== other.accessProof === false ? false : true)

  console.log("invite")
  const parsed = parseInviteKey(invite.inviteKey)
  ok("invite roundtrips", !!parsed && parsed.roomId === invite.roomId)
  ok("bad invite rejected", parseInviteKey("nope:bad") === null)
  const url = buildInviteUrl("https://example.com", invite.inviteKey)
  const fromUrl = parseInviteFromUrl(url)
  ok("invite url roundtrips", !!fromUrl && fromUrl.inviteKey === invite.inviteKey)
  ok("invite secret lives in fragment, not query", url.includes("#invite=") && !url.includes("?invite="))
  const legacy = "https://example.com/?invite=" + encodeURIComponent(invite.inviteKey)
  const fromLegacy = parseInviteFromUrl(legacy)
  ok("query invite secrets are rejected", fromLegacy === null)
  ok("url with no invite returns null", parseInviteFromUrl("https://example.com/") === null)

  console.log("padding")
  const j = JSON.stringify({ username: "anon", text: "hi" })
  const padded = padText(j)
  ok("padText rounds to 256", padded.length % 256 === 0)
  ok("padded json still parses", (JSON.parse(padded) as { text: string }).text === "hi")
  const blob = new Uint8Array([1, 2, 3, 4, 5])
  const pk = packAndPadMedia(blob)
  ok("media padded to bucket", pk.byteLength === mediaBucket(blob.byteLength + 4))
  const un = unpackMedia(pk)
  ok("media unpack roundtrips", un.byteLength === 5 && un[0] === 1 && un[4] === 5)

  console.log("reactions")
  const rid = await opaqueReactionId("room", "p1", "\u{1F525}", "12345")
  const rid2 = await opaqueReactionId("room", "p1", "\u{1F525}", "12345")
  ok("reaction id deterministic", rid === rid2)
  ok("reaction id hides emoji", !rid.includes("\u{1F525}") && /^[A-Za-z0-9_-]+$/.test(rid))
  const ridB = await opaqueReactionId("room", "p1", "\u2764\uFE0F", "12345")
  ok("different emoji -> different id", rid !== ridB)
  const ridSalt = await opaqueReactionId("room", "p1", "\u{1F525}", "99999")
  ok("salt changes id", rid !== ridSalt)

  console.log("roomCore")
  const now = Date.now()
  const core = new RoomCore()
  core.createRoom({ roomId: invite.roomId, accessProofHash: keys.accessProofHash, inviteExpiresAt: null, now })
  ok("room exists", core.exists())
  ok("valid proof accepted", core.verifyHash(keys.accessProofHash))
  ok("invalid proof denied", !core.verifyHash("deadbeef"))
  ok("validateInvite valid", core.validateInvite(keys.accessProofHash, now) === "valid")
  ok("validateInvite invalid", core.validateInvite("bad", now) === "invalid")

  // expiry blocks join but keeps data
  const expCore = new RoomCore()
  expCore.createRoom({ roomId: "r2", accessProofHash: keys.accessProofHash, inviteExpiresAt: now - 1000, now: now - 2000 })
  ok("expired invite blocked", expCore.validateInvite(keys.accessProofHash, now) === "expired")
  ok("expired room still exists", expCore.exists())

  // messages + prune
  core.addMessage({ id: "m1", participantId: "p1", envelope: env, kind: "text" }, now)
  core.addMessage({ id: "m2", participantId: "p2", envelope: env, kind: "text" }, now)
  ok("two messages stored", core.list(now).length === 2)
  const pr = core.prune(["m1"])
  ok("prune removes one", pr.removedIds.length === 1 && core.list(now).length === 1)
  core.pruneAll()
  ok("pruneAll clears", core.list(now).length === 0)

  // ttl sweep
  core.addMessage({ id: "m3", participantId: "p1", envelope: env, kind: "text", ttlMs: 1000 }, now - 5000)
  const swept = core.sweep(now)
  ok("expired message swept", swept.removedIds.includes("m3") && core.list(now).length === 0)

  // burn after read
  core.addMessage({ id: "b1", participantId: "sender", envelope: env, kind: "text", burn: true }, now)
  const reader = core.markRead("reader", now)
  ok("burn-after-read removes for other reader", reader.burnedIds.includes("b1"))

  // media orphan cleanup on delete
  const mediaCore = new RoomCore()
  mediaCore.createRoom({ roomId: "r3", accessProofHash: "h", inviteExpiresAt: null, now })
  mediaCore.addMessage(
    { id: "mm", participantId: "p", envelope: env, kind: "media", media: [{ objectKey: "rooms/r3/x", size: 10, previewKind: "image" }] },
    now,
  )
  const delKeys = mediaCore.deleteRoom(now)
  ok("delete returns orphan object keys", delKeys.includes("rooms/r3/x"))
  ok("deleted room no longer exists", !mediaCore.exists())

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
