import { useEffect, useState } from "react"
import { Download, Share2, X } from "lucide-react"
import type { RoomSession } from "../lib/session"
import { decryptToBlob, decryptToObjectUrl } from "../lib/media"
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

  useEffect(() => {
    let alive = true
    void decryptToObjectUrl(session, item.objectKey, item.mime).then((u) => {
      if (alive) setUrl(u)
    })
    return () => {
      alive = false
    }
  }, [session, item])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose()
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

  async function download() {
    const blob = await decryptToBlob(session, item.objectKey, item.mime)
    const a = document.createElement("a")
    a.href = URL.createObjectURL(blob)
    a.download = item.filename || "vanish-media"
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 4000)
  }

  async function share() {
    try {
      const blob = await decryptToBlob(session, item.objectKey, item.mime)
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
        <IconButton icon={<Share2 size={20} />} label="Share media" onClick={share} />
        <IconButton icon={<Download size={20} />} label="Download media" onClick={download} />
        <IconButton icon={<X size={22} />} label="Close viewer" onClick={onClose} />
      </div>
      <div className="viewer-stage">
        {!url ? (
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
