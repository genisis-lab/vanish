// Client-side media encryption + transfer. Files are encrypted with the room's
// media key before they ever leave the browser; only ciphertext lands in R2.
import { decryptBytes, encryptBytes } from "@shared/crypto"
import {
  MAX_MEDIA_PLAINTEXT_BYTES,
  MEDIA_CHUNK_BYTES,
  MEDIA_ENCRYPTED_CHUNK_BYTES,
  MULTIPART_MEDIA_THRESHOLD_BYTES,
} from "@shared/constants"
import { packAndPadMedia, unpackMedia } from "@shared/padding"
import type { EncryptedMediaRef, MultipartUploadedPart } from "@shared/types"
import { api } from "./api"
import { aad, type RoomSession } from "./session"
import {
  CHUNKED_MEDIA_FORMAT,
  decryptMediaChunk,
  encryptMediaChunk,
  isValidChunkedMedia,
  mediaChunkCount,
  multipartEncryptedSize,
} from "./chunkedMedia"

export type UploadStatus = "idle" | "encrypting" | "uploading" | "done" | "failed"

export type MediaPreviewKind = "image" | "video" | "audio"

export interface MediaManifestItem {
  objectKey: string
  filename: string
  mime: string
  size: number // original (plaintext) size
  encryptedSize?: number // server-stored ciphertext size from the message media ref
  previewKind: MediaPreviewKind
  /** Present for independently encrypted R2 multipart objects. */
  storageFormat?: typeof CHUNKED_MEDIA_FORMAT
  chunkSize?: number
  chunkCount?: number
  /** Tiny inline preview (JPEG data URL). It travels INSIDE the encrypted
   * message envelope, so the server never sees it. Lets images render
   * instantly before the full blob is downloaded + decrypted. */
  thumb?: string
}

function previewKindFor(mime: string): MediaPreviewKind {
  if (mime.startsWith("audio/")) return "audio"
  if (mime.startsWith("video/")) return "video"
  return "image"
}

interface NormalizedFile {
  blob: Blob
  mime: string
  size: number
  filename: string
}

// Re-encode images through a canvas to strip embedded metadata (EXIF, GPS,
// camera/timestamp tags) before encryption. Animated GIFs pass through untouched
// (canvas would flatten them); non-images (video, audio/voice notes) pass
// through too.
async function normalizeFile(file: File): Promise<NormalizedFile> {
  const passthrough = async (): Promise<NormalizedFile> => {
    return {
      blob: file,
      mime: file.type || "application/octet-stream",
      size: file.size,
      filename: file.name,
    }
  }
  if (
    !file.type.startsWith("image/") ||
    file.type === "image/gif" ||
    // Decoding a very large image into a canvas would defeat the bounded-memory
    // multipart path. Its metadata remains inside the E2EE payload.
    file.size > 50 * 1024 * 1024 ||
    typeof createImageBitmap !== "function" ||
    typeof document === "undefined"
  ) {
    return passthrough()
  }
  try {
    const bitmap = await createImageBitmap(file)
    const canvas = document.createElement("canvas")
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const ctx = canvas.getContext("2d")
    if (!ctx) return passthrough()
    ctx.drawImage(bitmap, 0, 0)
    bitmap.close?.()
    // Preserve PNG (lossless, possible alpha); everything else -> high-quality JPEG.
    const outMime = file.type === "image/png" ? "image/png" : "image/jpeg"
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, outMime, outMime === "image/jpeg" ? 0.92 : undefined),
    )
    if (!blob) return passthrough()
    const ext = outMime === "image/png" ? "png" : "jpg"
    const filename = file.name.replace(/\.[^./\\]+$/, "") + "." + ext
    return { blob, mime: outMime, size: blob.size, filename }
  } catch {
    return passthrough()
  }
}

// ---------- encrypted thumbnails ----------

const THUMB_MAX_DIM = 320
const THUMB_MAX_CHARS = 16_000

// Build a small inline preview for still images. Returned as a JPEG data URL
// that is embedded in the (encrypted) media manifest — never uploaded as a
// separate object, never visible to the server. Returns undefined for
// non-images, GIFs, or when the result would be too large.
async function makeThumb(file: File): Promise<string | undefined> {
  if (!file.type.startsWith("image/") || file.type === "image/gif") return undefined
  if (file.size > 50 * 1024 * 1024) return undefined
  if (typeof createImageBitmap !== "function" || typeof document === "undefined") return undefined
  try {
    const bitmap = await createImageBitmap(file)
    const scale = Math.min(1, THUMB_MAX_DIM / Math.max(bitmap.width, bitmap.height, 1))
    const w = Math.max(1, Math.round(bitmap.width * scale))
    const h = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = document.createElement("canvas")
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext("2d")
    if (!ctx) return undefined
    // Dark backfill so transparent PNGs look right on the dark theme.
    ctx.fillStyle = "#16161c"
    ctx.fillRect(0, 0, w, h)
    ctx.drawImage(bitmap, 0, 0, w, h)
    bitmap.close?.()
    for (const quality of [0.55, 0.4, 0.25]) {
      const url = canvas.toDataURL("image/jpeg", quality)
      if (url.length <= THUMB_MAX_CHARS) return url
    }
    return undefined
  } catch {
    return undefined
  }
}

export interface EncryptUploadResult {
  ref: EncryptedMediaRef
  manifest: MediaManifestItem
}

// Encrypt one file and upload the ciphertext. Returns the server ref + the
// manifest entry (filename/mime/caption stay encrypted inside the message).
export async function encryptAndUpload(
  session: RoomSession,
  file: File,
  onStatus: (status: UploadStatus, progress?: number) => void,
): Promise<EncryptUploadResult> {
  if (!Number.isInteger(file.size) || file.size <= 0 || file.size > MAX_MEDIA_PLAINTEXT_BYTES) {
    throw new Error("File exceeds the 2 GB limit")
  }
  onStatus("encrypting")
  const norm = await normalizeFile(file)
  if (norm.size <= 0 || norm.size > MAX_MEDIA_PLAINTEXT_BYTES) {
    throw new Error("File exceeds the 2 GB limit")
  }
  const thumb = await makeThumb(file)
  const previewKind = previewKindFor(norm.mime)
  if (norm.size > MULTIPART_MEDIA_THRESHOLD_BYTES) {
    return encryptAndUploadMultipart(session, norm, previewKind, thumb, onStatus)
  }

  // Pad the plaintext to a size bucket before encryption (length-hiding).
  const padded = packAndPadMedia(new Uint8Array(await norm.blob.arrayBuffer()))
  const cipher = await encryptBytes(session.keys.mediaKey, padded, aad(session, "media"))

  onStatus("uploading", 0)
  try {
    const sign = await api.signUpload({
      roomId: session.invite.roomId,
      accessProof: session.keys.accessProof,
      participantId: session.participantId,
      participantProof: session.participantProof,
      size: cipher.byteLength,
      previewKind,
    })
    await api.uploadBlob(sign, cipher, (loaded, total) =>
      onStatus("uploading", total ? loaded / total : 0),
    )
    onStatus("done")
    return {
      ref: { objectKey: sign.objectKey, size: cipher.byteLength, previewKind },
      manifest: {
        objectKey: sign.objectKey,
        filename: norm.filename,
        mime: norm.mime,
        size: norm.size,
        encryptedSize: cipher.byteLength,
        previewKind,
        thumb,
      },
    }
  } catch (err) {
    onStatus("failed")
    throw err
  }
}

async function encryptAndUploadMultipart(
  session: RoomSession,
  norm: NormalizedFile,
  previewKind: MediaPreviewKind,
  thumb: string | undefined,
  onStatus: (status: UploadStatus, progress?: number) => void,
): Promise<EncryptUploadResult> {
  const chunkCount = mediaChunkCount(norm.size)
  const encryptedSize = multipartEncryptedSize(norm.size)
  const sign = await api.signUpload({
    roomId: session.invite.roomId,
    accessProof: session.keys.accessProof,
    participantId: session.participantId,
    participantProof: session.participantProof,
    size: encryptedSize,
    previewKind,
    multipart: true,
  })
  let uploadId: string | null = null
  try {
    uploadId = (await api.createMultipartUpload(sign)).uploadId
    const parts: MultipartUploadedPart[] = []
    onStatus("uploading", 0)
    for (let index = 0; index < chunkCount; index++) {
      const start = index * MEDIA_CHUNK_BYTES
      const source = new Uint8Array(
        await norm.blob.slice(start, Math.min(norm.size, start + MEDIA_CHUNK_BYTES)).arrayBuffer(),
      )
      const encrypted = await encryptMediaChunk(
        session.keys.mediaKey,
        source,
        session.invite.roomId,
        sign.objectKey,
        index,
        norm.size,
      )
      const part = await uploadPartWithRetry(sign, uploadId, index + 1, encrypted, (loaded) => {
        const completed = index * MEDIA_ENCRYPTED_CHUNK_BYTES
        onStatus("uploading", Math.min(1, (completed + loaded) / encryptedSize))
      })
      parts.push(part)
      onStatus("uploading", ((index + 1) * MEDIA_ENCRYPTED_CHUNK_BYTES) / encryptedSize)
    }
    await api.completeMultipartUpload(sign, uploadId, parts)
    onStatus("done", 1)
    return {
      ref: { objectKey: sign.objectKey, size: encryptedSize, previewKind },
      manifest: {
        objectKey: sign.objectKey,
        filename: norm.filename,
        mime: norm.mime,
        size: norm.size,
        encryptedSize,
        previewKind,
        thumb,
        storageFormat: CHUNKED_MEDIA_FORMAT,
        chunkSize: MEDIA_CHUNK_BYTES,
        chunkCount,
      },
    }
  } catch (error) {
    if (uploadId) await api.abortMultipartUpload(sign, uploadId)
    onStatus("failed")
    throw error
  }
}

async function uploadPartWithRetry(
  sign: Awaited<ReturnType<typeof api.signUpload>>,
  uploadId: string,
  partNumber: number,
  encrypted: Uint8Array,
  onProgress: (loaded: number) => void,
): Promise<MultipartUploadedPart> {
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await api.uploadMultipartPart(sign, uploadId, partNumber, encrypted, onProgress)
    } catch (error) {
      lastError = error
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 400 * 2 ** attempt))
    }
  }
  throw lastError
}

const blobUrlCache = new Map<string, string>()
const decryptedBlobCache = new Map<string, Blob>()
export const MAX_IN_MEMORY_DECRYPT_BYTES = 256 * 1024 * 1024

export function requiresStreamingSave(item: MediaManifestItem): boolean {
  return item.storageFormat === CHUNKED_MEDIA_FORMAT && item.size > MAX_IN_MEMORY_DECRYPT_BYTES
}

// Download + decrypt a media object on demand, returning an object URL for the
// decrypted bytes. Cached so repeated previews don't re-download.
export async function decryptToObjectUrl(
  session: RoomSession,
  item: MediaManifestItem,
): Promise<string> {
  const cached = blobUrlCache.get(item.objectKey)
  if (cached) return cached
  const blob = await decryptToBlob(session, item)
  const url = URL.createObjectURL(blob)
  blobUrlCache.set(item.objectKey, url)
  return url
}

export async function decryptToBlob(
  session: RoomSession,
  item: MediaManifestItem,
): Promise<Blob> {
  const cached = decryptedBlobCache.get(item.objectKey)
  if (cached) return cached
  if (item.storageFormat === CHUNKED_MEDIA_FORMAT) {
    if (!isValidChunkedMedia(item)) throw new Error("Invalid chunked media manifest")
    if (requiresStreamingSave(item)) {
      throw new Error("Large media must be downloaded directly to a file")
    }
    const blob = await decryptChunkedToBlob(session, item)
    decryptedBlobCache.set(item.objectKey, blob)
    return blob
  }
  const cipher = await api.downloadBlob(session.invite.roomId, session.keys.accessProof, item.objectKey)
  const padded = await decryptBytes(session.keys.mediaKey, cipher, aad(session, "media"))
  const plain = unpackMedia(padded)
  const blob = new Blob([plain as unknown as BlobPart], { type: item.mime || "application/octet-stream" })
  decryptedBlobCache.set(item.objectKey, blob)
  return blob
}

async function decryptChunkedToBlob(session: RoomSession, item: MediaManifestItem): Promise<Blob> {
  const parts: BlobPart[] = []
  for (let index = 0; index < item.chunkCount!; index++) {
    parts.push((await downloadAndDecryptChunk(session, item, index)) as unknown as BlobPart)
  }
  return new Blob(parts, { type: item.mime || "application/octet-stream" })
}

/** Decrypt large chunked media directly into a user-selected destination. No
 * temporary plaintext is written to browser-private storage. */
export async function saveLargeMediaToFile(
  session: RoomSession,
  item: MediaManifestItem,
): Promise<void> {
  if (!requiresStreamingSave(item) || !isValidChunkedMedia(item)) {
    throw new Error("This attachment does not require streaming download")
  }
  const picker = (window as Window & {
    showSaveFilePicker?: (options: {
      suggestedName?: string
      types?: Array<{ description?: string; accept: Record<string, string[]> }>
    }) => Promise<FileSystemFileHandle>
  }).showSaveFilePicker
  if (!picker) {
    throw new Error("This browser cannot save a file this large. Use desktop Chrome or Edge.")
  }
  const handle = await picker({
    suggestedName: item.filename || "vanish-media",
    types: item.mime
      ? [{
          description: "Decrypted media",
          accept: { [item.mime.split(";", 1)[0]]: [extensionFor(item.filename)] },
        }]
      : undefined,
  })
  const writable = await handle.createWritable()
  try {
    for (let index = 0; index < item.chunkCount!; index++) {
      const plain = await downloadAndDecryptChunk(session, item, index)
      await writable.write(plain as unknown as FileSystemWriteChunkType)
    }
    await writable.close()
  } catch (error) {
    await writable.abort().catch(() => undefined)
    throw error
  }
}

function extensionFor(filename: string): string {
  const match = /\.[A-Za-z0-9]{1,12}$/.exec(filename)
  return match?.[0] ?? ".bin"
}

async function downloadAndDecryptChunk(
  session: RoomSession,
  item: MediaManifestItem,
  index: number,
): Promise<Uint8Array> {
  const encrypted = await api.downloadBlobRange(
    session.invite.roomId,
    session.keys.accessProof,
    item.objectKey,
    index * MEDIA_ENCRYPTED_CHUNK_BYTES,
    MEDIA_ENCRYPTED_CHUNK_BYTES,
  )
  return decryptMediaChunk(
    session.keys.mediaKey,
    encrypted,
    session.invite.roomId,
    item.objectKey,
    index,
    item.size,
  )
}

export function revokeAllObjectUrls(): void {
  for (const url of blobUrlCache.values()) URL.revokeObjectURL(url)
  blobUrlCache.clear()
  decryptedBlobCache.clear()
}
