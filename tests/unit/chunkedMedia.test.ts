import { describe, expect, it } from "vitest"
import { deriveKeys } from "@shared/crypto"
import { createInvite } from "@shared/invite"
import {
  MAX_MEDIA_CHUNKS,
  MAX_MEDIA_PLAINTEXT_BYTES,
  MEDIA_CHUNK_BYTES,
  MEDIA_ENCRYPTED_CHUNK_BYTES,
} from "@shared/constants"
import {
  CHUNKED_MEDIA_FORMAT,
  decryptMediaChunk,
  encryptMediaChunk,
  isValidChunkedMedia,
  mediaChunkCount,
  multipartEncryptedSize,
} from "@/lib/chunkedMedia"

describe("chunked encrypted media", () => {
  it("round trips and authenticates chunk ordering", async () => {
    const invite = createInvite()
    const keys = await deriveKeys(invite.secret, invite.roomId)
    const source = new TextEncoder().encode("a multipart secret")
    const objectKey = `rooms/${invite.roomId}/${"a".repeat(32)}`
    const encrypted = await encryptMediaChunk(
      keys.mediaKey,
      source,
      invite.roomId,
      objectKey,
      0,
      source.byteLength,
    )
    expect(encrypted.byteLength).toBe(MEDIA_ENCRYPTED_CHUNK_BYTES)
    expect(
      await decryptMediaChunk(
        keys.mediaKey,
        encrypted,
        invite.roomId,
        objectKey,
        0,
        source.byteLength,
      ),
    ).toEqual(source)
    await expect(
      decryptMediaChunk(keys.mediaKey, encrypted, invite.roomId, objectKey, 1, source.byteLength),
    ).rejects.toBeTruthy()
  })

  it("calculates and validates the 2 GiB multipart ceiling", () => {
    expect(mediaChunkCount(MAX_MEDIA_PLAINTEXT_BYTES)).toBe(MAX_MEDIA_CHUNKS)
    expect(multipartEncryptedSize(MAX_MEDIA_PLAINTEXT_BYTES)).toBe(
      MAX_MEDIA_CHUNKS * MEDIA_ENCRYPTED_CHUNK_BYTES,
    )
    expect(
      isValidChunkedMedia({
        storageFormat: CHUNKED_MEDIA_FORMAT,
        size: MEDIA_CHUNK_BYTES + 1,
        encryptedSize: 2 * MEDIA_ENCRYPTED_CHUNK_BYTES,
        chunkSize: MEDIA_CHUNK_BYTES,
        chunkCount: 2,
      }),
    ).toBe(true)
    expect(() => mediaChunkCount(MAX_MEDIA_PLAINTEXT_BYTES + 1)).toThrow(/2 GB/)
  })
})
