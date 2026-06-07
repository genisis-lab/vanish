import { useState } from "react"
import { Film, ImageIcon, Lock, Mic } from "lucide-react"
import type { RoomSession } from "../lib/session"
import { decryptToObjectUrl, type MediaManifestItem } from "../lib/media"
import { formatBytes } from "../lib/format"

export function MediaTile({
  session,
  item,
  onOpen,
}: {
  session: RoomSession
  item: MediaManifestItem
  onOpen: (item: MediaManifestItem) => void
}) {
  const [url, setUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const isAudio = item.previewKind === "audio"

  async function decrypt() {
    if (loading) return
    setLoading(true)
    setFailed(false)
    try {
      const u = await decryptToObjectUrl(session, item.objectKey, item.mime)
      setUrl(u)
    } catch {
      setFailed(true)
    } finally {
      setLoading(false)
    }
  }

  if (url) {
    // Voice notes get an inline player rather than a thumbnail/lightbox.
    if (isAudio) {
      return (
        <div className="media-tile audio-tile" style={AUDIO_TILE}>
          <Mic size={14} style= flex: "none"  />
          <audio src={url} controls preload="metadata" style= width: "100%"  />
        </div>
      )
    }
    return (
      <button className="media-tile" onClick={() => onOpen(item)} aria-label={`Open ${item.filename}`}>
        {item.previewKind === "video" ? (
          <video src={url} muted playsInline preload="metadata" />
        ) : (
          <img src={url} alt={item.filename} />
        )}
        <span className="media-badge">
          {item.previewKind === "video" ? <Film size={11} /> : <ImageIcon size={11} />}
          {item.previewKind}
        </span>
      </button>
    )
  }

  return (
    <button className="media-tile" onClick={decrypt} aria-label={`Decrypt ${item.filename}`}>
      <span className="loadbtn">
        {loading ? (
          <span className="spinner" />
        ) : (
          <>
            {isAudio ? <Mic size={18} /> : <Lock size={18} />}
            <span>
              {failed
                ? "Failed \u2014 tap to retry"
                : isAudio
                  ? "Tap to play voice note"
                  : "Tap to decrypt"}
            </span>
            <span style={DIM}>
              {isAudio ? "voice note" : item.previewKind} \u00b7 {formatBytes(item.size)}
            </span>
          </>
        )}
      </span>
    </button>
  )
}

const DIM = { color: "var(--text-faint)", fontSize: "11px" }
const AUDIO_TILE = {
  display: "flex",
  alignItems: "center",
  gap: "8px",
  padding: "8px 10px",
  minWidth: "220px",
  cursor: "default",
}
