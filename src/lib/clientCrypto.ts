import { randomBytes, toBase64Url } from "@shared/crypto"

// URL-safe random id used for participant ids, message ids and upload ids.
export function randomId(bytes = 12): string {
  return toBase64Url(randomBytes(bytes))
}

// Import raw channel-key bytes into a non-extractable AES-GCM key for the
// realtime signalling channel (typing indicators, etc.).
export async function importAesKey(raw: Uint8Array): Promise<CryptoKey> {
  const subtle = globalThis.crypto.subtle
  return subtle.importKey("raw", raw as unknown as BufferSource, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ])
}
