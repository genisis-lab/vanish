import { decryptBytes, encryptBytes } from "@shared/crypto"
import {
  MAX_MEDIA_CHUNKS,
  MAX_MEDIA_PLAINTEXT_BYTES,
  MEDIA_CHUNK_BYTES,
  MEDIA_ENCRYPTED_CHUNK_BYTES,
} from "@shared/constants"

export const CHUNKED_MEDIA_FORMAT = "chunked-v1" as const

export interface ChunkedMediaDescriptor {
  storageFormat?: typeof CHUNKED_MEDIA_FORMAT
  size: number
  encryptedSize?: number
  chunkSize?: number
  chunkCount?: number
}

export function mediaChunkCount(plaintextSize: number): number {
  if (!Number.isInteger(plaintextSize) || plaintextSize <= 0 || plaintextSize > MAX_MEDIA_PLAINTEXT_BYTES) {
    throw new Error("File exceeds the 2 GB limit")
  }
  return Math.ceil(plaintextSize / MEDIA_CHUNK_BYTES)
}

export function multipartEncryptedSize(plaintextSize: number): number {
  return mediaChunkCount(plaintextSize) * MEDIA_ENCRYPTED_CHUNK_BYTES
}

export function isValidChunkedMedia(item: ChunkedMediaDescriptor): boolean {
  if (item.storageFormat !== CHUNKED_MEDIA_FORMAT) return false
  if (
    item.chunkSize !== MEDIA_CHUNK_BYTES ||
    !Number.isInteger(item.chunkCount) ||
    item.chunkCount! < 1 ||
    item.chunkCount! > MAX_MEDIA_CHUNKS ||
    !Number.isInteger(item.size) ||
    item.size <= 0 ||
    item.size > MAX_MEDIA_PLAINTEXT_BYTES
  ) return false
  const expectedCount = Math.ceil(item.size / MEDIA_CHUNK_BYTES)
  return (
    item.chunkCount === expectedCount &&
    item.encryptedSize === expectedCount * MEDIA_ENCRYPTED_CHUNK_BYTES
  )
}

function chunkAad(roomId: string, objectKey: string, index: number, plaintextSize: number): string {
  return `${roomId}:media-chunk-v1:${objectKey}:${index}:${plaintextSize}`
}

/** Encrypt one fixed-size, independently authenticated part. The final source
 * slice is zero-padded so every R2 part has the same ciphertext length. */
export async function encryptMediaChunk(
  key: CryptoKey,
  source: Uint8Array,
  roomId: string,
  objectKey: string,
  index: number,
  plaintextSize: number,
): Promise<Uint8Array> {
  if (source.byteLength > MEDIA_CHUNK_BYTES) throw new Error("media chunk is too large")
  const padded = new Uint8Array(MEDIA_CHUNK_BYTES)
  padded.set(source)
  const encrypted = await encryptBytes(
    key,
    padded,
    chunkAad(roomId, objectKey, index, plaintextSize),
  )
  if (encrypted.byteLength !== MEDIA_ENCRYPTED_CHUNK_BYTES) {
    throw new Error("unexpected encrypted chunk size")
  }
  return encrypted
}

export async function decryptMediaChunk(
  key: CryptoKey,
  encrypted: Uint8Array,
  roomId: string,
  objectKey: string,
  index: number,
  plaintextSize: number,
): Promise<Uint8Array> {
  if (encrypted.byteLength !== MEDIA_ENCRYPTED_CHUNK_BYTES) {
    throw new Error("invalid encrypted chunk size")
  }
  const padded = await decryptBytes(
    key,
    encrypted,
    chunkAad(roomId, objectKey, index, plaintextSize),
  )
  if (padded.byteLength !== MEDIA_CHUNK_BYTES) throw new Error("invalid media chunk")
  const remaining = plaintextSize - index * MEDIA_CHUNK_BYTES
  if (remaining <= 0) throw new Error("invalid media chunk index")
  return padded.slice(0, Math.min(MEDIA_CHUNK_BYTES, remaining))
}
