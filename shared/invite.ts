// Invite key handling.
//
// Invite key format:  anonchat:v1:<roomId>.<secret>
//   roomId  = base64url(16 random bytes)  (also the Durable Object name)
//   secret  = base64url(32 random bytes)  (never sent to the server)
//
// The full secret only ever lives client-side. Losing the invite key means the
// room and its history are unrecoverable — by design.
//
// IMPORTANT: invite links carry the secret in the URL *fragment* (after `#`).
// Browsers never transmit the fragment to the server, so the secret stays out
// of access logs, Referer headers, and proxies.

import { fromBase64Url, randomBytes, toBase64Url } from "./crypto"

export const INVITE_PREFIX = "anonchat:v1:"

export interface ParsedInvite {
  roomId: string
  secret: Uint8Array
  secretB64: string
  inviteKey: string
}

export function createInvite(): ParsedInvite {
  const roomId = toBase64Url(randomBytes(16))
  const secret = randomBytes(32)
  const secretB64 = toBase64Url(secret)
  return { roomId, secret, secretB64, inviteKey: `${INVITE_PREFIX}${roomId}.${secretB64}` }
}

export function parseInviteKey(raw: string): ParsedInvite | null {
  if (!raw) return null
  const trimmed = raw.trim()
  if (!trimmed.startsWith(INVITE_PREFIX)) return null
  const body = trimmed.slice(INVITE_PREFIX.length)
  const dot = body.indexOf(".")
  if (dot <= 0 || dot >= body.length - 1) return null
  const roomId = body.slice(0, dot)
  const secretB64 = body.slice(dot + 1)
  if (!/^[A-Za-z0-9_-]+$/.test(roomId) || !/^[A-Za-z0-9_-]+$/.test(secretB64)) return null
  let secret: Uint8Array
  try {
    secret = fromBase64Url(secretB64)
  } catch {
    return null
  }
  if (secret.length < 16) return null
  return { roomId, secret, secretB64, inviteKey: `${INVITE_PREFIX}${roomId}.${secretB64}` }
}

export function buildInviteUrl(origin: string, inviteKey: string): string {
  const base = origin.replace(/\/$/, "")
  // Secret lives in the fragment so it is never sent to the server.
  return `${base}/#invite=${encodeURIComponent(inviteKey)}`
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

function parseInviteFromHash(hash: string): ParsedInvite | null {
  if (!hash) return null
  let raw = hash.startsWith("#") ? hash.slice(1) : hash
  if (raw.startsWith("invite=")) raw = raw.slice("invite=".length)
  if (!raw) return null
  return parseInviteKey(safeDecode(raw))
}

export function parseInviteFromUrl(url: string): ParsedInvite | null {
  try {
    const u = new URL(url)
    return parseInviteFromHash(u.hash)
  } catch {
    return null
  }
}
