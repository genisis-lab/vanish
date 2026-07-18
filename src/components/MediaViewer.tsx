import { useEffect, useState } from "react"
import { Download, Share2, X } from "lucide-react"
import type { RoomSession } from "../lib/session"
import {
  decryptToBlob,
  decryptToObjectUrl,
  requiresStreamingSave,
  saveLargeMediaToFile,
} from "../lib/media"
import type { MediaManifestItem } from "../lib/media"
import { IconButton, useToast } from "./ui"

export function MediaViewer({
  session,
  item,
  onClose,
}: {
  session: RoomSession
  item: MediaManifestItem
  onClose: () => void
}) {
  const toast = useToast()
  const [url, setUrl] = useState<string | null>(null)
  const downloadOnly = requiresStreamingSave(item)

  useEffect(() => {
    if (downloadOnly) return
    let alive = true
    void decryptToObjectUrl(session, item)
      .then((u) => {
        if (alive) setUrl(u)
      })
      .catch(() => {
        if (alive) toast("Could not decrypt this attachment")
      })
    return () => {
      alive = false
    }
  }, [session, item, downloadOnly, toast])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose()
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

  async function download() {
    try {
      if (downloadOnly) {
        await saveLargeMediaToFile(session, item)
        toast("Decrypted file saved")
        return
      }
      const blob = await decryptToBlob(session, item)
      const a = document.createElement("a")
      a.href = URL.createObjectURL(blob)
      a.download = item.filename || "vanish-media"
      a.click()
      setTimeout(() => URL.revokeObjectURL(a.href), 4000)
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return
      toast(error instanceof Error ? error.message : "Download failed")
    }
  }

  async function share() {
    try {
      const blob = await decryptToBlob(session, item)
      const file = new File([blob], item.filename || "vanish-media", { type: item.mime })
      const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean }
      if (nav.share && (!nav.canShare || nav.canShare({ files: [file] }))) {
        await nav.share({ files: [file], title: item.filename })
      } else {
        await download()
      }
    } catch {
      toast("Share canceled")
    }
  }

  return (
    <div className="viewer" role="dialog" aria-modal="true" aria-label={item.filename}>
      <div className="viewer-top">
        {!downloadOnly && <IconButton icon={<Share2 size={20} />} label="Share media" onClick={share} />}
        <IconButton icon={<Download size={20} />} label="Download media" onClick={download} />
        <IconButton icon={<X size={22} />} label="Close viewer" onClick={onClose} />
      </div>
      <div className="viewer-stage">
        {downloadOnly ? (
          <div className="callout">
            This encrypted file is too large to preview safely in memory. Downloading decrypts
            each 16 MiB part directly into the destination you choose.
          </div>
        ) : !url ? (
          <span className="spinner" />
        ) : item.previewKind === "video" ? (
          <video src={url} controls autoPlay playsInline />
        ) : (
          <img src={url} alt={item.filename} />
        )}
      </div>
    </div>
  )
}
