// Client-side media encryption + transfer. Files are encrypted with the room's
// media key before they ever leave the browser; only ciphertext lands in R2.
import { decryptBytes, encryptBytes } from "@shared/crypto"
import { packAndPadMedia, unpackMedia } from "@shared/padding"
import type { EncryptedMediaRef } from "@shared/types"
import { api } from "./api"
import { aad, type RoomSession } from "./session"

export type UploadStatus = "idle" | "encrypting" | "uploading" | "done" | "failed"

export type MediaPreviewKind = "image" | "video" | "audio"

export interface MediaManifestItem {
  objectKey: string
  filename: string
  mime: string
  size: number // original (plaintext) size
  encryptedSize?: number // server-stored ciphertext size from the message media ref
  previewKind: MediaPreviewKind
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
  data: Uint8Array
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
    const data = new Uint8Array(await file.arrayBuffer())
    return {
      data,
      mime: file.type || "application/octet-stream",
      size: data.byteLength,
      filename: file.name,
    }
  }
  if (
    !file.type.startsWith("image/") ||
    file.type === "image/gif" ||
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
    const data = new Uint8Array(await blob.arrayBuffer())
    const ext = outMime === "image/png" ? "png" : "jpg"
    const filename = file.name.replace(/\.[^./\\]+$/, "") + "." + ext
    return { data, mime: outMime, size: data.byteLength, filename }
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
  onStatus("encrypting")
  const norm = await normalizeFile(file)
  const thumb = await makeThumb(file)
  const previewKind = previewKindFor(norm.mime)
  // Pad the plaintext to a size bucket before encryption (length-hiding).
  const padded = packAndPadMedia(norm.data)
  const cipher = await encryptBytes(session.keys.mediaKey, padded, aad(session, "media"))

  onStatus("uploading", 0)
  try {
    const sign = await api.signUpload({
      roomId: session.invite.roomId,
      accessProof: session.keys.accessProof,
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

const blobUrlCache = new Map<string, string>()

// Download + decrypt a media object on demand, returning an object URL for the
// decrypted bytes. Cached so repeated previews don't re-download.
export async function decryptToObjectUrl(
  session: RoomSession,
  objectKey: string,
  mime: string,
): Promise<string> {
  const cached = blobUrlCache.get(objectKey)
  if (cached) return cached
  const cipher = await api.downloadBlob(session.invite.roomId, session.keys.accessProof, objectKey)
  const padded = await decryptBytes(session.keys.mediaKey, cipher, aad(session, "media"))
  const plain = unpackMedia(padded)
  const blob = new Blob([plain as unknown as BlobPart], { type: mime || "application/octet-stream" })
  const url = URL.createObjectURL(blob)
  blobUrlCache.set(objectKey, url)
  return url
}

export async function decryptToBlob(
  session: RoomSession,
  objectKey: string,
  mime: string,
): Promise<Blob> {
  const cipher = await api.downloadBlob(session.invite.roomId, session.keys.accessProof, objectKey)
  const padded = await decryptBytes(session.keys.mediaKey, cipher, aad(session, "media"))
  const plain = unpackMedia(padded)
  return new Blob([plain as unknown as BlobPart], { type: mime || "application/octet-stream" })
}

export function revokeAllObjectUrls(): void {
  for (const url of blobUrlCache.values()) URL.revokeObjectURL(url)
  blobUrlCache.clear()
}
