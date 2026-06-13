// A RoomSession bundles the derived keys + identity for one joined room.
import {
  deriveKeys,
  exportSigningKeyPair,
  generateSigningKeyPair,
  importSigningKeyPair,
  type DerivedKeys,
  type SigningKeyPair,
} from "@shared/crypto"
import type { ParsedInvite } from "@shared/invite"
import { importAesKey, randomId } from "./clientCrypto"
import { loadOwnerSecret } from "./owner"

export interface RoomSession {
  invite: ParsedInvite
  keys: DerivedKeys
  /** AES-GCM key for realtime signalling envelopes (typing/seen). */
  channelKey: CryptoKey
  participantId: string
  /** Per-device bearer proof for participant-scoped server actions. */
  participantProof: string
  username: string
  /** Per-room Ed25519 signing identity, persisted locally (see
   * loadOrCreateSigning) so a returning participant keeps the SAME key across
   * rejoins. Undefined when the runtime lacks WebCrypto Ed25519, in which case
   * messages are sent unsigned (and peers simply show no verification state). */
  signing?: SigningKeyPair
  /** Owner secret (proof-of-possession) when this device created the room or
   * imported owner rights via multi-device sync. Present => owner controls. */
  ownerSecret?: string
}

// Per-room signing identity is persisted locally so a participant who rejoins
// (same participantId) keeps the SAME Ed25519 signing key. Without this the key
// would be regenerated on every load while participantId stays stable, and
// peers' trust-on-first-use pinning would incorrectly flag every rejoin as a
// "key changed" event. The private key is stored only in this browser and is
// never sent anywhere; it is far less sensitive than the room secret, which
// already lives in local storage.
const SIGNING_STORE_PREFIX = "vanish.sign.v1:"
const PARTICIPANT_PROOF_STORE_PREFIX = "vanish.participant.v1:"

function signingStoreKey(roomId: string, participantId: string): string {
  return `${SIGNING_STORE_PREFIX}${roomId}:${participantId}`
}

function participantProofStoreKey(roomId: string, participantId: string): string {
  return `${PARTICIPANT_PROOF_STORE_PREFIX}${roomId}:${participantId}`
}

function loadOrCreateParticipantProof(
  roomId: string,
  participantId: string,
  supplied?: string,
): string {
  const storeKey = participantProofStoreKey(roomId, participantId)
  if (supplied) {
    try {
      localStorage.setItem(storeKey, supplied)
    } catch {
      /* storage is best-effort */
    }
    return supplied
  }
  try {
    const saved = localStorage.getItem(storeKey)
    if (saved) return saved
  } catch {
    /* fall through and generate */
  }
  const generated = randomId(32)
  try {
    localStorage.setItem(storeKey, generated)
  } catch {
    /* storage is best-effort */
  }
  return generated
}

async function loadOrCreateSigning(
  roomId: string,
  participantId: string,
): Promise<SigningKeyPair | undefined> {
  const canStore = typeof localStorage !== "undefined"
  const storeKey = signingStoreKey(roomId, participantId)
  if (canStore) {
    try {
      const raw = localStorage.getItem(storeKey)
      if (raw) {
        const saved = JSON.parse(raw) as { priv: string; pub: string }
        const imported = await importSigningKeyPair(saved.priv, saved.pub)
        if (imported) return imported
      }
    } catch {
      /* fall through and regenerate */
    }
  }
  const generated = (await generateSigningKeyPair()) ?? undefined
  if (generated && canStore) {
    try {
      const exported = await exportSigningKeyPair(generated)
      if (exported) localStorage.setItem(storeKey, JSON.stringify(exported))
    } catch {
      /* persistence is best-effort */
    }
  }
  return generated
}

export async function buildSession(
  invite: ParsedInvite,
  username: string,
  participantId?: string,
  participantProof?: string,
): Promise<RoomSession> {
  const keys = await deriveKeys(invite.secret, invite.roomId)
  const channelKey = await importAesKey(keys.channelKey)
  const pid = participantId || randomId(9)
  const proof = loadOrCreateParticipantProof(invite.roomId, pid, participantProof)
  const signing = await loadOrCreateSigning(invite.roomId, pid)
  return {
    invite,
    keys,
    channelKey,
    participantId: pid,
    participantProof: proof,
    username: username.trim() || "anon",
    signing,
    ownerSecret: loadOwnerSecret(invite.roomId),
  }
}

/** AAD context binds an envelope to its room + purpose to prevent cross-context replay. */
export function aad(session: RoomSession, purpose: string): string {
  return `${session.invite.roomId}:${purpose}`
}
