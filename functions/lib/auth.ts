// One-time R2 upload tokens.
//
// The token only authorizes writing a specific encrypted object of a specific
// size before an expiry. It is unrelated to end-to-end encryption — the bytes
// being uploaded are already ciphertext.

import { toBase64Url, utf8 } from "../../shared/crypto"
import { timingSafeEqual } from "../../shared/roomCore"

async function hmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    utf8(secret) as unknown as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const sig = await crypto.subtle.sign("HMAC", key, utf8(message) as unknown as BufferSource)
  return toBase64Url(new Uint8Array(sig))
}

function payload(objectKey: string, size: number, exp: number): string {
  return `${objectKey}:${size}:${exp}`
}

export async function signUploadToken(
  secret: string,
  objectKey: string,
  size: number,
  exp: number,
): Promise<string> {
  return hmac(secret, payload(objectKey, size, exp))
}

export async function verifyUploadToken(
  secret: string,
  objectKey: string,
  size: number,
  exp: number,
  token: string,
): Promise<boolean> {
  if (Date.now() > exp) return false
  if (typeof token !== "string" || !token) return false
  const expected = await signUploadToken(secret, objectKey, size, exp)
  return timingSafeEqual(expected, token)
}

/**
 * Returns the configured upload secret, or null when not configured.
 * Handlers MUST fail closed (503) when this is null. The previous hard-coded
 * dev fallback was a publicly-known string committed to the repo, which would
 * have let anyone forge upload tokens if UPLOAD_SECRET was ever unset in
 * production.
 */
export function uploadSecret(env: { UPLOAD_SECRET?: string }): string | null {
  return env.UPLOAD_SECRET || null
}
