import { describe, expect, it } from "vitest"
import {
  decryptBytes,
  decryptString,
  deriveKeys,
  encryptBytes,
  encryptString,
  fromBase64Url,
  hashAccessProof,
  randomBytes,
  toBase64Url,
  utf8,
} from "@shared/crypto"
import { createInvite } from "@shared/invite"

describe("crypto: AES-GCM round trip", () => {
  it("same key decrypts what it encrypted", async () => {
    const { secret, roomId } = createInvite()
    const keys = await deriveKeys(secret, roomId)
    const ct = await encryptString(keys.msgKey, "hello world \u{1F510}")
    expect(await decryptString(keys.msgKey, ct)).toBe("hello world \u{1F510}")
  })

  it("wrong key fails to decrypt", async () => {
    const a = createInvite()
    const b = createInvite()
    const ka = await deriveKeys(a.secret, a.roomId)
    const kb = await deriveKeys(b.secret, b.roomId)
    const ct = await encryptString(ka.msgKey, "secret text")
    await expect(decryptString(kb.msgKey, ct)).rejects.toBeTruthy()
  })

  it("tampered ciphertext fails authentication", async () => {
    const { secret, roomId } = createInvite()
    const keys = await deriveKeys(secret, roomId)
    const env = await encryptBytes(keys.msgKey, utf8("do not tamper"))
    env[env.length - 1] ^= 0x01 // flip a bit in the GCM tag / ciphertext
    await expect(decryptBytes(keys.msgKey, env)).rejects.toBeTruthy()
  })

  it("AAD mismatch fails", async () => {
    const { secret, roomId } = createInvite()
    const keys = await deriveKeys(secret, roomId)
    const ct = await encryptString(keys.msgKey, "bound", `${roomId}|text`)
    await expect(decryptString(keys.msgKey, ct, `${roomId}|media`)).rejects.toBeTruthy()
  })
})

describe("crypto: HKDF key separation", () => {
  it("derives distinct keys per purpose", async () => {
    const { secret, roomId } = createInvite()
    const keys = await deriveKeys(secret, roomId)
    // message key cannot decrypt media-key ciphertext
    const mediaCt = await encryptString(keys.mediaKey, "media manifest")
    await expect(decryptString(keys.msgKey, mediaCt)).rejects.toBeTruthy()
    // channel key bytes differ from proof material
    expect(toBase64Url(keys.channelKey)).not.toBe(keys.accessProof)
  })

  it("access proof hashes match for the same invite, differ across rooms", async () => {
    const a = createInvite()
    const ka = await deriveKeys(a.secret, a.roomId)
    const ka2 = await deriveKeys(a.secret, a.roomId)
    expect(ka.accessProofHash).toBe(ka2.accessProofHash)
    expect(await hashAccessProof(ka.accessProof)).toBe(ka.accessProofHash)

    const b = createInvite()
    const kb = await deriveKeys(b.secret, b.roomId)
    expect(kb.accessProofHash).not.toBe(ka.accessProofHash)
  })

  it("safety number is stable and groups of five", async () => {
    const { secret, roomId } = createInvite()
    const k1 = await deriveKeys(secret, roomId)
    const k2 = await deriveKeys(secret, roomId)
    expect(k1.safetyNumber).toBe(k2.safetyNumber)
    expect(k1.safetyNumber.replace(/ /g, "").length).toBe(60)
  })
})

describe("crypto: base64url", () => {
  it("round trips arbitrary bytes", () => {
    const bytes = randomBytes(129)
    expect([...fromBase64Url(toBase64Url(bytes))]).toEqual([...bytes])
  })
})
