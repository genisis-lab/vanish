// Room owner credential. The creator of a room gets a random "owner secret"
// that is stored ONLY on their device (never sent to the server). Owner-gated
// actions (set topic, ban, clear, destroy) present this secret as a
// proof-of-possession; the server stores only its SHA-256 and compares hashes.
//
// This is deliberately separate from the shared access proof (which everyone
// with the invite link holds) so that merely being in the room does not grant
// moderation powers. Rooms created before this existed simply have no owner and
// expose no owner controls.
import { hashAccessProof, randomBytes, toBase64Url } from "@shared/crypto"

const OWNER_PREFIX = "vanish.owner.v1:"

function storeKey(roomId: string): string {
  return `${OWNER_PREFIX}${roomId}`
}

/** Generate a fresh 256-bit owner secret (base64url). */
export function generateOwnerSecret(): string {
  return toBase64Url(randomBytes(32))
}

/** SHA-256 of the owner secret — the verifier registered with the server. */
export function ownerKeyHash(secret: string): Promise<string> {
  return hashAccessProof(secret)
}

export function saveOwnerSecret(roomId: string, secret: string): void {
  try {
    localStorage.setItem(storeKey(roomId), secret)
  } catch {
    /* storage may be unavailable (private mode); owner powers won't persist */
  }
}

export function loadOwnerSecret(roomId: string): string | undefined {
  try {
    return localStorage.getItem(storeKey(roomId)) ?? undefined
  } catch {
    return undefined
  }
}

export function clearOwnerSecret(roomId: string): void {
  try {
    localStorage.removeItem(storeKey(roomId))
  } catch {
    /* ignore */
  }
}
