// Client-side media encryption + transfer. Files are encrypted with the room's
// media key before they ever leave the browser; only ciphertext lands in R2.
import { decryptBytes, encryptBytes } from "@shared/crypto"
import type { EncryptedMediaRef } from "@shared/types"
import { api } from "./api"
import { aad, type RoomSession } from "./session"

export type UploadStatus = "idle" | "encrypting" | "uploading" | "done" | "failed"

export interface MediaManifestItem {
  objectKey: string
  filename: string
  mime: string
  size: number // original (plaintext) size
  previewKind: "image" | "video"
}

function previewKindFor(mime: string): "image" | "video" {
  return mime.startsWith("video/") ? "video" : "image"
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
  const plain = new Uint8Array(await file.arrayBuffer())
  const previewKind = previewKindFor(file.type)
  const cipher = await encryptBytes(session.keys.mediaKey, plain, aad(session, "media"))

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
        filename: file.name,
        mime: file.type || "application/octet-stream",
        size: plain.byteLength,
        previewKind,
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
  const plain = await decryptBytes(session.keys.mediaKey, cipher, aad(session, "media"))
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
  const plain = await decryptBytes(session.keys.mediaKey, cipher, aad(session, "media"))
  return new Blob([plain as unknown as BlobPart], { type: mime || "application/octet-stream" })
}

export function revokeAllObjectUrls(): void {
  for (const url of blobUrlCache.values()) URL.revokeObjectURL(url)
  blobUrlCache.clear()
}
