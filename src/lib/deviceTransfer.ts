// Multi-device sync via a high-entropy, short-lived device transfer code.
//
// A room's identity lives only on the device that created/joined it: the invite
// secret, the stable participant id + proof, the per-room Ed25519 signing
// keypair and (for owners) the owner secret. To use the same room on a second device we
// bundle all of that, encrypt it under a 128-bit pairing secret (PBKDF2-SHA-256 -> AES-GCM)
// and render it as a QR / copyable code. Nothing here ever touches the server;
// the transfer is device-to-device (scan or paste). The pairing secret gates
// decryption and the AES-GCM tag authenticates the bundle.
//
// Layout of the encrypted blob: [salt(16)] [iv(12)] [ciphertext]. The code is
// the app prefix + base64url(blob).
import { fromBase64Url, fromUtf8, randomBytes, toBase64Url, utf8 } from "@shared/crypto"
import { parseInviteKey } from "@shared/invite"
import { vault } from "./vault"

export const DEVICE_PREFIX = "vanish-device:v2:"
export const DEVICE_TRANSFER_TTL_MS = 10 * 60 * 1000
const PBKDF2_ITERS = 250_000
const SALT_LEN = 16
const IV_LEN = 12
export interface DeviceBundle {
  inviteKey: string
  username: string
  participantId: string
  participantProof: string
  /** present only when transferring owner rights */
  ownerSecret?: string
  /** exported per-room signing keypair (priv PKCS#8 + raw pub), base64url */
  signing?: { priv: string; pub: string }
  /** Embedded by buildDeviceTransfer; callers do not need to provide it. */
  expiresAt?: number
}

function subtle(): SubtleCrypto {
  return globalThis.crypto.subtle
}

async function deriveTransferKey(pairingSecret: string, salt: Uint8Array): Promise<CryptoKey> {
  const base = await subtle().importKey(
    "raw",
    utf8(pairingSecret) as unknown as BufferSource,
    "PBKDF2",
    false,
    ["deriveKey"],
  )
  return subtle().deriveKey(
    { name: "PBKDF2", salt: salt as unknown as BufferSource, iterations: PBKDF2_ITERS, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  )
}

/** Build a short-lived transfer code for the given bundle. */
export async function buildDeviceTransfer(bundle: DeviceBundle, pairingSecret: string): Promise<string> {
  const salt = randomBytes(SALT_LEN)
  const iv = randomBytes(IV_LEN)
  const key = await deriveTransferKey(pairingSecret, salt)
  const payload = { ...bundle, expiresAt: Date.now() + DEVICE_TRANSFER_TTL_MS }
  const ct = new Uint8Array(
    await subtle().encrypt(
      { name: "AES-GCM", iv: iv as unknown as BufferSource },
      key,
      utf8(JSON.stringify(payload)) as unknown as BufferSource,
    ),
  )
  const out = new Uint8Array(SALT_LEN + IV_LEN + ct.length)
  out.set(salt, 0)
  out.set(iv, SALT_LEN)
  out.set(ct, SALT_LEN + IV_LEN)
  return DEVICE_PREFIX + toBase64Url(out)
}

/** Parse + decrypt a transfer code with the pairing secret. */
export async function parseDeviceTransfer(token: string, pairingSecret: string): Promise<DeviceBundle> {
  const trimmed = token.trim()
  if (!trimmed.startsWith(DEVICE_PREFIX)) throw new Error("That is not a Vanish device-transfer code")
  let raw: Uint8Array
  try {
    raw = fromBase64Url(trimmed.slice(DEVICE_PREFIX.length))
  } catch {
    throw new Error("Transfer code is corrupt")
  }
  if (raw.length < SALT_LEN + IV_LEN + 16) throw new Error("Transfer code is corrupt")
  const salt = raw.slice(0, SALT_LEN)
  const iv = raw.slice(SALT_LEN, SALT_LEN + IV_LEN)
  const ct = raw.slice(SALT_LEN + IV_LEN)
  const key = await deriveTransferKey(pairingSecret, salt)
  let pt: Uint8Array
  try {
    pt = new Uint8Array(
      await subtle().decrypt({ name: "AES-GCM", iv: iv as unknown as BufferSource }, key, ct as unknown as BufferSource),
    )
  } catch {
    throw new Error("Wrong pairing secret or corrupt transfer code")
  }
  let parsed: DeviceBundle
  try {
    parsed = JSON.parse(fromUtf8(pt)) as DeviceBundle
  } catch {
    throw new Error("Transfer code is corrupt")
  }
  if (!parsed.inviteKey || !parseInviteKey(parsed.inviteKey)) {
    throw new Error("Transfer code is missing a valid room key")
  }
  if (!Number.isFinite(parsed.expiresAt) || parsed.expiresAt! <= Date.now()) {
    throw new Error("This transfer code has expired")
  }
  return parsed
}

/** Persist a decrypted bundle on THIS device (invite + owner rights + signing
 * identity), then return the room id so the caller can resume it. */
export function applyDeviceBundle(bundle: DeviceBundle): { roomId: string } {
  const invite = parseInviteKey(bundle.inviteKey)
  if (!invite) throw new Error("Invalid room key in transfer")
  const roomId = invite.roomId
  vault.save({
    roomId,
    inviteKey: bundle.inviteKey,
    username: bundle.username || "anon",
    participantId: bundle.participantId,
    participantProof: bundle.participantProof,
    ownerSecret: bundle.ownerSecret,
    signing: bundle.signing,
    lastUsed: Date.now(),
  })
  return { roomId }
}
