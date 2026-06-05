// Size-padding helpers.
//
// AES-GCM ciphertext length reveals the plaintext length. Padding rounds the
// plaintext up to coarse buckets so the server (and a network observer) learns
// far less about message/media content sizes. Pure + dependency-free so it runs
// in the browser, Workers, Node, and the test runner alike.

const TEXT_BUCKET = 256

/**
 * Pad a JSON string with trailing spaces up to the next TEXT_BUCKET multiple.
 * JSON.parse ignores trailing whitespace, so decoding is unchanged.
 */
export function padText(json: string): string {
  const target = Math.ceil((json.length + 1) / TEXT_BUCKET) * TEXT_BUCKET
  return json + " ".repeat(target - json.length)
}

const MEDIA_PREFIX = 4 // bytes: uint32 big-endian true length
const KB = 1024
const MEDIA_BUCKETS = [4 * KB, 16 * KB, 64 * KB, 256 * KB, 1024 * KB, 4096 * KB]

export function mediaBucket(n: number): number {
  for (const b of MEDIA_BUCKETS) if (n <= b) return b
  return Math.ceil(n / (1024 * KB)) * (1024 * KB)
}

/**
 * Prefix the bytes with a 4-byte big-endian length, then zero-pad up to a size
 * bucket. Self-describing, so decoding needs no external size metadata.
 */
export function packAndPadMedia(data: Uint8Array): Uint8Array {
  const target = mediaBucket(data.byteLength + MEDIA_PREFIX)
  const out = new Uint8Array(target)
  new DataView(out.buffer).setUint32(0, data.byteLength, false)
  out.set(data, MEDIA_PREFIX)
  return out
}

/** Inverse of packAndPadMedia: read the length prefix and slice off padding. */
export function unpackMedia(padded: Uint8Array): Uint8Array {
  if (padded.byteLength < MEDIA_PREFIX) return padded
  const len = new DataView(padded.buffer, padded.byteOffset, padded.byteLength).getUint32(0, false)
  if (len > padded.byteLength - MEDIA_PREFIX) return padded.slice(MEDIA_PREFIX)
  return padded.slice(MEDIA_PREFIX, MEDIA_PREFIX + len)
}
