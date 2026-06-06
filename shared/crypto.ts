// Vanish cryptography core.
//
// Runs in browsers (Web Crypto) and in Node 18+/Workers, which all expose the
// same `crypto.subtle` Web Crypto API on `globalThis`. No plaintext chat
// content or media ever leaves the client unencrypted.
//
// Key hierarchy (HKDF-SHA-256, salt bound to the room id):
//   invite secret ->
//     - msg     : AES-GCM message-encryption key
//     - media   : AES-GCM media-encryption key
//     - proof   : server access proof (proof-of-possession, never the secret)
//     - channel : realtime / signalling key (typing, presence)
//     - safety  : safety-number / fingerprint material
//
// Separately, each device generates an Ed25519 signing keypair, persisted
// locally per room (see generateSigningKeyPair / exportSigningKeyPair) so a
// returning participant keeps a stable signing identity. That key is NOT derived
// from the room secret on purpose: deriving it from shared material would let any
// room member forge another member's signature. The private key never leaves the
// device; the public key travels inside the encrypted envelope so peers can
// verify authorship.

export const APP = "vanish"
export const VERSION = "v1"

const subtle = (): SubtleCrypto => {
  const c = (globalThis as { crypto?: Crypto }).crypto
  if (!c?.subtle) throw new Error("Web Crypto (crypto.subtle) is not available in this environment")
  return c.subtle
}

export function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length)
  globalThis.crypto.getRandomValues(out)
  return out
}

// ---------- encoding helpers ----------

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

export function utf8(s: string): Uint8Array {
  return textEncoder.encode(s)
}

export function fromUtf8(b: Uint8Array): string {
  return textDecoder.decode(b)
}

export function toBase64Url(bytes: Uint8Array): string {
  let bin = ""
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  const b64 = btoaShim(bin)
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

export function fromBase64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4)
  const bin = atobShim(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

// btoa/atob exist in browsers and Workers. Provide a Buffer fallback for Node.
function btoaShim(bin: string): string {
  if (typeof btoa === "function") return btoa(bin)
  return Buffer.from(bin, "binary").toString("base64")
}
function atobShim(b64: string): string {
  if (typeof atob === "function") return atob(b64)
  return Buffer.from(b64, "base64").toString("binary")
}

// ---------- hashing ----------

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const digest = await subtle().digest("SHA-256", bytes as unknown as BufferSource)
  return new Uint8Array(digest)
}

export async function sha256Base64Url(bytes: Uint8Array): Promise<string> {
  return toBase64Url(await sha256(bytes))
}

// ---------- key derivation ----------

export type KeyPurpose = "msg" | "media" | "proof" | "channel" | "safety"

function hkdfInfo(purpose: KeyPurpose): Uint8Array {
  return utf8(`${APP}:${VERSION}:${purpose}`)
}

function hkdfSalt(roomId: string): Uint8Array {
  return utf8(`${APP}:${VERSION}:salt:${roomId}`)
}

async function importBaseKey(secret: Uint8Array): Promise<CryptoKey> {
  return subtle().importKey("raw", secret as unknown as BufferSource, "HKDF", false, [
    "deriveKey",
    "deriveBits",
  ])
}

async function deriveAesKey(
  base: CryptoKey,
  roomId: string,
  purpose: Extract<KeyPurpose, "msg" | "media">,
): Promise<CryptoKey> {
  return subtle().deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: hkdfSalt(roomId) as unknown as BufferSource, info: hkdfInfo(purpose) as unknown as BufferSource },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  )
}

async function deriveRawBits(
  base: CryptoKey,
  roomId: string,
  purpose: KeyPurpose,
  bits = 256,
): Promise<Uint8Array> {
  const out = await subtle().deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: hkdfSalt(roomId) as unknown as BufferSource, info: hkdfInfo(purpose) as unknown as BufferSource },
    base,
    bits,
  )
  return new Uint8Array(out)
}

export interface DerivedKeys {
  roomId: string
  msgKey: CryptoKey
  mediaKey: CryptoKey
  channelKey: Uint8Array
  /** Raw access proof (proof-of-possession). Sent to the server on data ops. */
  accessProof: string
  /** SHA-256 of the access proof. Stored server-side as the room verifier. */
  accessProofHash: string
  /** Stable, human-comparable safety number derived for out-of-band verification. */
  safetyNumber: string
}

export async function deriveKeys(secret: Uint8Array, roomId: string): Promise<DerivedKeys> {
  const base = await importBaseKey(secret)
  const [msgKey, mediaKey, channelKey, proofBits, safetyBits] = await Promise.all([
    deriveAesKey(base, roomId, "msg"),
    deriveAesKey(base, roomId, "media"),
    deriveRawBits(base, roomId, "channel"),
    deriveRawBits(base, roomId, "proof"),
    deriveRawBits(base, roomId, "safety"),
  ])
  const accessProof = toBase64Url(proofBits)
  const accessProofHash = await sha256Base64Url(proofBits)
  return {
    roomId,
    msgKey,
    mediaKey,
    channelKey,
    accessProof,
    accessProofHash,
    safetyNumber: formatSafetyNumber(safetyBits),
  }
}

/** Server-side: hash a presented access proof to compare against the stored verifier. */
export async function hashAccessProof(accessProof: string): Promise<string> {
  return sha256Base64Url(fromBase64Url(accessProof))
}

// Render derived safety bits as a 60-digit number grouped in blocks of five,
// mirroring the familiar Signal-style safety-number presentation.
export function formatSafetyNumber(bits: Uint8Array): string {
  let digits = ""
  for (let i = 0; i < bits.length && digits.length < 60; i++) {
    digits += (bits[i] % 100).toString().padStart(2, "0")
  }
  digits = digits.slice(0, 60).padEnd(60, "0")
  return (digits.match(/.{1,5}/g) || []).join(" ")
}

// ---------- per-sender signing (Ed25519) ----------
//
// Each device generates one signing keypair per room (persisted locally so it
// stays stable across rejoins) and signs every message it sends. Recipients
// verify the signature against the public key carried inside the (encrypted)
// envelope, so a participant who merely holds the shared room key cannot forge
// messages attributed to another sender. Trust-on-first-use pinning + the
// fingerprint below let peers detect a key that changes mid-conversation.

export interface SigningKeyPair {
  privateKey: CryptoKey
  publicKey: CryptoKey
  /** Raw 32-byte Ed25519 public key, base64url. Travels inside the envelope. */
  publicKeyB64: string
}

// Cache the one-time capability check: some older runtimes lack WebCrypto
// Ed25519, in which case the app runs without per-sender signing.
let ed25519Supported: boolean | null = null

export async function generateSigningKeyPair(): Promise<SigningKeyPair | null> {
  if (ed25519Supported === false) return null
  try {
    // Extractable so the keypair can be persisted locally (see
    // exportSigningKeyPair) and reloaded for a stable identity across rejoins.
    const pair = (await subtle().generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair
    const rawPub = new Uint8Array(await subtle().exportKey("raw", pair.publicKey))
    ed25519Supported = true
    return {
      privateKey: pair.privateKey,
      publicKey: pair.publicKey,
      publicKeyB64: toBase64Url(rawPub),
    }
  } catch {
    ed25519Supported = false
    return null
  }
}

// Export a signing keypair to a persistable form (private key as PKCS#8, public
// key as the raw base64url already carried in envelopes). Stored only on this
// device; never transmitted.
export async function exportSigningKeyPair(
  pair: SigningKeyPair,
): Promise<{ priv: string; pub: string } | null> {
  try {
    const pkcs8 = new Uint8Array(await subtle().exportKey("pkcs8", pair.privateKey))
    return { priv: toBase64Url(pkcs8), pub: pair.publicKeyB64 }
  } catch {
    return null
  }
}

// Re-import a previously exported signing keypair so a returning participant
// keeps a stable signing identity across reloads. Returns null if the runtime
// lacks Ed25519 or the stored material is unusable (caller then regenerates).
export async function importSigningKeyPair(
  privPkcs8B64: string,
  publicKeyB64: string,
): Promise<SigningKeyPair | null> {
  if (ed25519Supported === false) return null
  try {
    const privateKey = await subtle().importKey(
      "pkcs8",
      fromBase64Url(privPkcs8B64) as unknown as BufferSource,
      { name: "Ed25519" },
      true,
      ["sign"],
    )
    const publicKey = await subtle().importKey(
      "raw",
      fromBase64Url(publicKeyB64) as unknown as BufferSource,
      { name: "Ed25519" },
      false,
      ["verify"],
    )
    ed25519Supported = true
    return { privateKey, publicKey, publicKeyB64 }
  } catch {
    return null
  }
}

export async function signEd25519(privateKey: CryptoKey, bytes: Uint8Array): Promise<string> {
  const sig = new Uint8Array(
    await subtle().sign({ name: "Ed25519" }, privateKey, bytes as unknown as BufferSource),
  )
  return toBase64Url(sig)
}

export async function verifyEd25519(
  publicKeyB64: string,
  signatureB64: string,
  bytes: Uint8Array,
): Promise<boolean> {
  try {
    const pub = await subtle().importKey(
      "raw",
      fromBase64Url(publicKeyB64) as unknown as BufferSource,
      { name: "Ed25519" },
      false,
      ["verify"],
    )
    return await subtle().verify(
      { name: "Ed25519" },
      pub,
      fromBase64Url(signatureB64) as unknown as BufferSource,
      bytes as unknown as BufferSource,
    )
  } catch {
    return false
  }
}

// Short, human-comparable fingerprint of a signing public key: first 8 bytes of
// its SHA-256, rendered as four groups of four hex chars.
export async function signingFingerprint(publicKeyB64: string): Promise<string> {
  const digest = await sha256(fromBase64Url(publicKeyB64))
  let hex = ""
  for (let i = 0; i < 8; i++) hex += digest[i].toString(16).padStart(2, "0")
  return (hex.match(/.{1,4}/g) || []).join(" ")
}

// ---------- opaque reaction ids ----------
//
// The reaction *envelope* is encrypted, but its storage id must be stable per
// (participant, emoji) so toggling overwrites. To avoid leaking the emoji to the
// server via the id, we hash it together with a secret-derived salt (the safety
// number, which never leaves the client). The server only ever stores the hash.
export async function opaqueReactionId(
  roomId: string,
  participantId: string,
  emoji: string,
  salt: string,
): Promise<string> {
  return sha256Base64Url(utf8(`${roomId}:${participantId}:${emoji}:${salt}`))
}

// ---------- AES-GCM envelopes ----------
//
// Envelope binary layout: [version(1)] [iv(12)] [ciphertext(...)] -> base64url.
// Optional Additional Authenticated Data binds ciphertext to a context string
// (e.g. roomId|kind) so envelopes cannot be replayed across contexts.

const ENVELOPE_VERSION = 1
const IV_LENGTH = 12

export async function encryptBytes(
  key: CryptoKey,
  plaintext: Uint8Array,
  aad?: string,
): Promise<Uint8Array> {
  const iv = randomBytes(IV_LENGTH)
  const params: AesGcmParams = { name: "AES-GCM", iv: iv as unknown as BufferSource }
  if (aad) params.additionalData = utf8(aad) as unknown as BufferSource
  const ct = new Uint8Array(
    await subtle().encrypt(params, key, plaintext as unknown as BufferSource),
  )
  const out = new Uint8Array(1 + IV_LENGTH + ct.length)
  out[0] = ENVELOPE_VERSION
  out.set(iv, 1)
  out.set(ct, 1 + IV_LENGTH)
  return out
}

export async function decryptBytes(
  key: CryptoKey,
  envelope: Uint8Array,
  aad?: string,
): Promise<Uint8Array> {
  if (envelope.length < 1 + IV_LENGTH + 16) throw new Error("ciphertext too short")
  if (envelope[0] !== ENVELOPE_VERSION) throw new Error("unsupported envelope version")
  const iv = envelope.slice(1, 1 + IV_LENGTH)
  const ct = envelope.slice(1 + IV_LENGTH)
  const params: AesGcmParams = { name: "AES-GCM", iv: iv as unknown as BufferSource }
  if (aad) params.additionalData = utf8(aad) as unknown as BufferSource
  const pt = await subtle().decrypt(params, key, ct as unknown as BufferSource)
  return new Uint8Array(pt)
}

export async function encryptString(key: CryptoKey, plaintext: string, aad?: string): Promise<string> {
  return toBase64Url(await encryptBytes(key, utf8(plaintext), aad))
}

export async function decryptString(key: CryptoKey, envelopeB64: string, aad?: string): Promise<string> {
  return fromUtf8(await decryptBytes(key, fromBase64Url(envelopeB64), aad))
}

export async function encryptJson(key: CryptoKey, value: unknown, aad?: string): Promise<string> {
  return encryptString(key, JSON.stringify(value), aad)
}

export async function decryptJson<T>(key: CryptoKey, envelopeB64: string, aad?: string): Promise<T> {
  return JSON.parse(await decryptString(key, envelopeB64, aad)) as T
}
