// A RoomSession bundles the derived keys + identity for one joined room.
import { deriveKeys, generateSigningKeyPair, type DerivedKeys, type SigningKeyPair } from "@shared/crypto"
import type { ParsedInvite } from "@shared/invite"
import { importAesKey, randomId } from "./clientCrypto"

export interface RoomSession {
  invite: ParsedInvite
  keys: DerivedKeys
  /** AES-GCM key for realtime signalling envelopes (typing/seen). */
  channelKey: CryptoKey
  participantId: string
  username: string
  /** Per-session Ed25519 signing identity. Undefined when the runtime lacks
   * WebCrypto Ed25519, in which case messages are sent unsigned (and peers
   * simply show no verification state for them). */
  signing?: SigningKeyPair
}

export async function buildSession(
  invite: ParsedInvite,
  username: string,
  participantId?: string,
): Promise<RoomSession> {
  const keys = await deriveKeys(invite.secret, invite.roomId)
  const channelKey = await importAesKey(keys.channelKey)
  const signing = (await generateSigningKeyPair()) ?? undefined
  return {
    invite,
    keys,
    channelKey,
    participantId: participantId || randomId(9),
    username: username.trim() || "anon",
    signing,
  }
}

/** AAD context binds an envelope to its room + purpose to prevent cross-context replay. */
export function aad(session: RoomSession, purpose: string): string {
  return `${session.invite.roomId}:${purpose}`
}
