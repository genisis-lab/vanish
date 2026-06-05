// A RoomSession bundles the derived keys + identity for one joined room.
import { deriveKeys, type DerivedKeys } from "@shared/crypto"
import type { ParsedInvite } from "@shared/invite"
import { importAesKey, randomId } from "./clientCrypto"

export interface RoomSession {
  invite: ParsedInvite
  keys: DerivedKeys
  /** AES-GCM key for realtime signalling envelopes (typing/seen). */
  channelKey: CryptoKey
  participantId: string
  username: string
}

export async function buildSession(
  invite: ParsedInvite,
  username: string,
  participantId?: string,
): Promise<RoomSession> {
  const keys = await deriveKeys(invite.secret, invite.roomId)
  const channelKey = await importAesKey(keys.channelKey)
  return {
    invite,
    keys,
    channelKey,
    participantId: participantId || randomId(9),
    username: username.trim() || "anon",
  }
}

/** AAD context binds an envelope to its room + purpose to prevent cross-context replay. */
export function aad(session: RoomSession, purpose: string): string {
  return `${session.invite.roomId}:${purpose}`
}
