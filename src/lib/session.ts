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
import { clearOwnerSecret, loadOwnerSecret } from "./owner"

export interface StoredSessionCredentials {
  ownerSecret?: string
  signing?: { priv: string; pub: string }
}

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
  /** Serializable copy kept inside the encrypted room vault. */
  signingExport?: { priv: string; pub: string }
  /** Owner secret (proof-of-possession) when this device created the room or
   * imported owner rights via multi-device sync. Present => owner controls. */
  ownerSecret?: string
}

// A participant who rejoins with the same participantId must keep the SAME
// Ed25519 signing key or peers' trust-on-first-use pinning would flag a key
// change. Current credentials live in the remembered-room vault; these legacy
// keys are read once for migration and then removed from raw localStorage.
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
      localStorage.removeItem(storeKey)
    } catch {
      /* storage is best-effort */
    }
    return supplied
  }
  try {
    const saved = localStorage.getItem(storeKey)
    if (saved) {
      localStorage.removeItem(storeKey)
      return saved
    }
  } catch {
    /* fall through and generate */
  }
  const generated = randomId(32)
  return generated
}

async function loadOrCreateSigning(
  roomId: string,
  participantId: string,
  supplied?: { priv: string; pub: string },
): Promise<{ pair?: SigningKeyPair; exported?: { priv: string; pub: string } }> {
  const canStore = typeof localStorage !== "undefined"
  const storeKey = signingStoreKey(roomId, participantId)
  if (supplied) {
    const imported = await importSigningKeyPair(supplied.priv, supplied.pub)
    if (imported) return { pair: imported, exported: supplied }
  }
  if (canStore) {
    try {
      const raw = localStorage.getItem(storeKey)
      if (raw) {
        const saved = JSON.parse(raw) as { priv: string; pub: string }
        const imported = await importSigningKeyPair(saved.priv, saved.pub)
        localStorage.removeItem(storeKey)
        if (imported) return { pair: imported, exported: saved }
      }
    } catch {
      /* fall through and regenerate */
    }
  }
  const generated = (await generateSigningKeyPair()) ?? undefined
  const exported = generated ? (await exportSigningKeyPair(generated)) ?? undefined : undefined
  return { pair: generated, exported }
}

export async function buildSession(
  invite: ParsedInvite,
  username: string,
  participantId?: string,
  participantProof?: string,
  credentials: StoredSessionCredentials = {},
): Promise<RoomSession> {
  const keys = await deriveKeys(invite.secret, invite.roomId)
  const channelKey = await importAesKey(keys.channelKey)
  const pid = participantId || randomId(9)
  const proof = loadOrCreateParticipantProof(invite.roomId, pid, participantProof)
  const signing = await loadOrCreateSigning(invite.roomId, pid, credentials.signing)
  const ownerSecret = credentials.ownerSecret ?? loadOwnerSecret(invite.roomId)
  clearOwnerSecret(invite.roomId)
  return {
    invite,
    keys,
    channelKey,
    participantId: pid,
    participantProof: proof,
    username: username.trim() || "anon",
    signing: signing.pair,
    signingExport: signing.exported,
    ownerSecret,
  }
}

/** AAD context binds an envelope to its room + purpose to prevent cross-context replay. */
export function aad(session: RoomSession, purpose: string): string {
  return `${session.invite.roomId}:${purpose}`
}
