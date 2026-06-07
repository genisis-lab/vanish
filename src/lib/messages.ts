// Encoding/decoding of encrypted message envelopes. The server only ever sees
// the opaque `envelope` string; everything meaningful (username, text, caption,
// filenames, media manifest) is encrypted here with the room message key.
//
// On top of confidentiality, each message carries a per-sender Ed25519 signature
// (and the signer's public key) *inside* the encrypted payload. Recipients
// verify it so that holding the shared room key is not enough to forge a message
// attributed to someone else. The signature is computed over a canonical binding
// of room id + message id + participant id + kind + content, so a captured
// envelope cannot be re-attributed to a different id/sender without detection.
import {
  decryptJson,
  encryptString,
  opaqueReactionId,
  signEd25519,
  utf8,
  verifyEd25519,
} from "@shared/crypto"
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
  /** signer public key (base64url) */
  spk?: string
  /** Ed25519 signature (base64url) */
  sig?: string
  /** decoy/cover-traffic marker: recipients silently discard these. */
  decoy?: boolean
}
export interface MediaPayload {
  username: string
  caption: string
  items: MediaManifestItem[]
  replyTo?: ReplyRef
  spk?: string
  sig?: string
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
  /** server time the author last edited this message, if ever */
  editedAt?: number | null
  /** soft-deleted tombstone: the author removed this message for everyone */
  deleted?: boolean
  /** decoy/cover-traffic message: decoded but never shown to the user */
  decoy?: boolean
  /** transient client-only send state */
  pending?: boolean
  failed?: boolean
  /** per-sender signature result: "ok" valid, "bad" present-but-invalid,
   * "none" unsigned (legacy/unsupported). undefined for system/undecryptable. */
  verified?: "ok" | "bad" | "none"
  /** signer's Ed25519 public key (base64url), used for trust-on-first-use pinning */
  signerKey?: string
  /** set by the room controller when this participant's signing key differs
   * from the first key seen for them this session */
  keyChanged?: boolean
}

// Canonical bytes that get signed/verified. Everything here is reconstructable
// by the recipient from the decrypted payload + the server-relayed stored
// metadata (id/participantId/kind), so a mismatch reliably fails verification.
interface SignCore {
  username: string
  text: string
  replyToId: string
  mediaKeys: string
}
function signableBytes(
  roomId: string,
  id: string,
  pid: string,
  kind: MessageKind,
  core: SignCore,
): Uint8Array {
  return utf8(
    JSON.stringify({
      v: 1,
      room: roomId,
      id,
      pid,
      kind,
      u: core.username,
      t: core.text,
      r: core.replyToId,
      m: core.mediaKeys,
    }),
  )
}

async function attachSignature(
  session: RoomSession,
  payload: { spk?: string; sig?: string },
  id: string,
  kind: MessageKind,
  core: SignCore,
): Promise<void> {
  if (!session.signing) return
  payload.spk = session.signing.publicKeyB64
  payload.sig = await signEd25519(
    session.signing.privateKey,
    signableBytes(session.invite.roomId, id, session.participantId, kind, core),
  )
}

async function verifySignature(
  session: RoomSession,
  stored: StoredMessage,
  core: SignCore,
  spk?: string,
  sig?: string,
): Promise<"ok" | "bad" | "none"> {
  if (!spk || !sig) return "none"
  const ok = await verifyEd25519(
    spk,
    sig,
    signableBytes(session.invite.roomId, stored.id, stored.participantId, stored.kind, core),
  )
  return ok ? "ok" : "bad"
}

// Encrypt a payload, padding the plaintext to a size bucket first so the
// ciphertext length leaks less about the content (see shared/padding).
async function encryptPadded(key: CryptoKey, value: unknown, context: string): Promise<string> {
  return encryptString(key, padText(JSON.stringify(value)), context)
}

export async function encodeText(
  session: RoomSession,
  id: string,
  text: string,
  replyTo?: ReplyRef,
): Promise<string> {
  const payload: TextPayload = { username: session.username, text, replyTo }
  await attachSignature(session, payload, id, "text", {
    username: session.username,
    text,
    replyToId: replyTo?.id ?? "",
    mediaKeys: "",
  })
  return encryptPadded(session.keys.msgKey, payload, aad(session, "msg"))
}

// Cover traffic: an encrypted message that looks exactly like a real one to the
// server/observers but is flagged decoy INSIDE the ciphertext so recipients drop
// it. Not signed (it carries no authorship meaning) and intentionally padded
// like normal text so its size blends in.
export async function encodeDecoy(session: RoomSession, id: string): Promise<string> {
  const payload: TextPayload = { username: session.username, text: "", decoy: true }
  return encryptPadded(session.keys.msgKey, payload, aad(session, "msg"))
  void id
}

export async function encodeMedia(
  session: RoomSession,
  id: string,
  caption: string,
  items: MediaManifestItem[],
  replyTo?: ReplyRef,
): Promise<string> {
  const payload: MediaPayload = { username: session.username, caption, items, replyTo }
  await attachSignature(session, payload, id, "media", {
    username: session.username,
    text: caption,
    replyToId: replyTo?.id ?? "",
    mediaKeys: items.map((i) => i.objectKey).join(","),
  })
  return encryptPadded(session.keys.msgKey, payload, aad(session, "msg"))
}

export async function encodeSystem(session: RoomSession, payload: SystemPayload): Promise<string> {
  return encryptPadded(session.keys.msgKey, payload, aad(session, "msg"))
}

export async function encodeReaction(session: RoomSession, emoji: string): Promise<string> {
  const payload: ReactionPayload = { emoji, username: session.username }
  return encryptPadded(session.keys.msgKey, payload, aad(session, "react"))
}

// ---------- encrypted room topic/name ----------
//
// The room topic is opaque to the server (same msgKey, distinct AAD context so
// it can't be swapped with a chat message). Only the owner can set it server-
// side, but any member can decrypt it for display.
export async function encodeTopic(session: RoomSession, topic: string): Promise<string> {
  return encryptString(session.keys.msgKey, JSON.stringify({ topic }), aad(session, "topic"))
}

export async function decodeTopic(session: RoomSession, envelope: string): Promise<string> {
  try {
    const p = await decryptJson<{ topic: string }>(
      session.keys.msgKey,
      envelope,
      aad(session, "topic"),
    )
    return (p.topic || "").slice(0, 200)
  } catch {
    return ""
  }
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
    editedAt: stored.editedAt ?? null,
    reactions: [],
  }

  // Soft-deleted tombstone: nothing left to decrypt; render a neutral notice.
  if (stored.deletedAt) {
    base.deleted = true
    return base
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
      base.signerKey = p.spk
      base.verified = await verifySignature(
        session,
        stored,
        {
          username: p.username,
          text: p.caption,
          replyToId: p.replyTo?.id ?? "",
          mediaKeys: (p.items || []).map((i) => i.objectKey).join(","),
        },
        p.spk,
        p.sig,
      )
    } else {
      const p = await decryptJson<TextPayload>(session.keys.msgKey, stored.envelope, aad(session, "msg"))
      // Cover-traffic messages decrypt fine but must never be shown.
      if (p.decoy) {
        base.decoy = true
        return base
      }
      base.username = p.username
      base.text = p.text
      base.replyTo = p.replyTo
      base.signerKey = p.spk
      base.verified = await verifySignature(
        session,
        stored,
        { username: p.username, text: p.text, replyToId: p.replyTo?.id ?? "", mediaKeys: "" },
        p.spk,
        p.sig,
      )
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
