// Encoding/decoding of encrypted message envelopes. The server only ever sees
// the opaque `envelope` string; everything meaningful (username, text, caption,
// filenames, media manifest) is encrypted here with the room message key.
import { decryptJson, encryptString, opaqueReactionId } from "@shared/crypto"
import { padText } from "@shared/padding"
import type { EncryptedMediaRef, MessageKind, StoredMessage } from "@shared/types"
import type { MediaManifestItem } from "./media"
import { aad, type RoomSession } from "./session"

/** A lightweight quoted reference to another message, stored inside the
 * encrypted envelope (never visible to the server). */
export interface ReplyRef {
  id: string
  username: string
  preview: string
}
export interface TextPayload {
  username: string
  text: string
  replyTo?: ReplyRef
}
export interface MediaPayload {
  username: string
  caption: string
  items: MediaManifestItem[]
  replyTo?: ReplyRef
}
export interface SystemPayload {
  event: "join" | "leave" | "notice"
  username?: string
  text: string
}
export interface ReactionPayload {
  emoji: string
  username: string
}

export interface DecryptedReaction {
  emoji: string
  count: number
  mine: boolean
  users: string[]
}

export interface DecryptedMessage {
  id: string
  participantId: string
  kind: MessageKind
  createdAt: number
  expiresAt: number | null
  mine: boolean
  username: string
  text?: string
  items?: MediaManifestItem[]
  media?: EncryptedMediaRef[]
  system?: SystemPayload
  reactions: DecryptedReaction[]
  /** quoted message this one replies to */
  replyTo?: ReplyRef
  /** read-once: server burns this after another participant reads it */
  burn?: boolean
  /** transient client-only send state */
  pending?: boolean
  failed?: boolean
}

// Encrypt a payload, padding the plaintext to a size bucket first so the
// ciphertext length leaks less about the content (see shared/padding).
async function encryptPadded(key: CryptoKey, value: unknown, context: string): Promise<string> {
  return encryptString(key, padText(JSON.stringify(value)), context)
}

export async function encodeText(
  session: RoomSession,
  text: string,
  replyTo?: ReplyRef,
): Promise<string> {
  const payload: TextPayload = { username: session.username, text, replyTo }
  return encryptPadded(session.keys.msgKey, payload, aad(session, "msg"))
}

export async function encodeMedia(
  session: RoomSession,
  caption: string,
  items: MediaManifestItem[],
  replyTo?: ReplyRef,
): Promise<string> {
  const payload: MediaPayload = { username: session.username, caption, items, replyTo }
  return encryptPadded(session.keys.msgKey, payload, aad(session, "msg"))
}

export async function encodeSystem(session: RoomSession, payload: SystemPayload): Promise<string> {
  return encryptPadded(session.keys.msgKey, payload, aad(session, "msg"))
}

export async function encodeReaction(session: RoomSession, emoji: string): Promise<string> {
  const payload: ReactionPayload = { emoji, username: session.username }
  return encryptPadded(session.keys.msgKey, payload, aad(session, "react"))
}

export async function decodeMessage(
  session: RoomSession,
  stored: StoredMessage,
): Promise<DecryptedMessage> {
  const mine = stored.participantId === session.participantId
  const base: DecryptedMessage = {
    id: stored.id,
    participantId: stored.participantId,
    kind: stored.kind,
    createdAt: stored.createdAt,
    expiresAt: stored.expiresAt,
    mine,
    username: "anon",
    media: stored.media,
    burn: stored.burn,
    reactions: [],
  }

  try {
    if (stored.kind === "system") {
      const p = await decryptJson<SystemPayload>(session.keys.msgKey, stored.envelope, aad(session, "msg"))
      base.system = p
      base.username = p.username || "system"
      base.text = p.text
    } else if (stored.kind === "media") {
      const p = await decryptJson<MediaPayload>(session.keys.msgKey, stored.envelope, aad(session, "msg"))
      base.username = p.username
      base.text = p.caption
      base.items = p.items
      base.replyTo = p.replyTo
    } else {
      const p = await decryptJson<TextPayload>(session.keys.msgKey, stored.envelope, aad(session, "msg"))
      base.username = p.username
      base.text = p.text
      base.replyTo = p.replyTo
    }
  } catch {
    base.text = "\u26a0 Unable to decrypt (different key)"
  }

  base.reactions = await decodeReactions(session, stored)
  return base
}

async function decodeReactions(
  session: RoomSession,
  stored: StoredMessage,
): Promise<DecryptedReaction[]> {
  const byEmoji = new Map<string, DecryptedReaction>()
  for (const r of Object.values(stored.reactions || {})) {
    try {
      const p = await decryptJson<ReactionPayload>(session.keys.msgKey, r.envelope, aad(session, "react"))
      const existing = byEmoji.get(p.emoji) || { emoji: p.emoji, count: 0, mine: false, users: [] }
      existing.count++
      existing.users.push(p.username)
      // "mine" comes from the stored participant id, not the reaction id (the id
      // is now an opaque hash that intentionally hides the emoji).
      if (r.participantId === session.participantId) existing.mine = true
      byEmoji.set(p.emoji, existing)
    } catch {
      /* skip unreadable reaction */
    }
  }
  return Array.from(byEmoji.values())
}

/** Opaque, stable reaction id so a participant toggling the same emoji
 * overwrites itself — without leaking the emoji to the server. */
export function reactionId(session: RoomSession, emoji: string): Promise<string> {
  return opaqueReactionId(
    session.invite.roomId,
    session.participantId,
    emoji,
    session.keys.safetyNumber,
  )
}
