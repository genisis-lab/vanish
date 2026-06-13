import { useEffect, useRef, useState } from "react"
import { Film, ImageIcon, Lock, Mic, Pause, Play } from "lucide-react"
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
  const alive = useRef(true)
  const isAudio = item.previewKind === "audio"
  const autoDecryptAudio =
    isAudio && (item.encryptedSize ?? Number.MAX_SAFE_INTEGER) <= AUTO_DECRYPT_AUDIO_BYTES

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  async function decrypt() {
    if (loading) return
    setLoading(true)
    setFailed(false)
    try {
      const u = await decryptToObjectUrl(session, item.objectKey, item.mime)
      if (alive.current) setUrl(u)
    } catch {
      if (alive.current) setFailed(true)
    } finally {
      if (alive.current) setLoading(false)
    }
  }

  // Small voice notes auto-decrypt in the background, but large/suspicious
  // audio requires a tap so another member cannot force big downloads on render.
  useEffect(() => {
    if (autoDecryptAudio && !url && !loading && !failed) void decrypt()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoDecryptAudio])

  if (isAudio) {
    return (
      <div className="media-tile audio-tile" style={AUDIO_TILE}>
        <Mic size={14} style={AUDIO_ICON} />
        {url ? (
          <VoicePlayer src={url} />
        ) : failed ? (
          <button type="button" className="btn" style={AUDIO_RETRY} onClick={decrypt}>
            Failed — tap to retry
          </button>
        ) : !autoDecryptAudio ? (
          <button type="button" className="btn" style={AUDIO_RETRY} onClick={decrypt}>
            Tap to decrypt · {formatBytes(item.size)}
          </button>
        ) : (
          <span style={AUDIO_LOADING}>
            <span className="spinner" />
            <span style={DIM}>Decrypting voice note…</span>
          </span>
        )}
      </div>
    )
  }

  if (url) {
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

  // Instant preview: images carry a tiny thumbnail INSIDE the encrypted
  // envelope, so they can render immediately — tap opens the full-quality
  // viewer (which downloads + decrypts the real blob).
  if (item.thumb && item.previewKind === "image") {
    return (
      <button className="media-tile" onClick={() => onOpen(item)} aria-label={`Open ${item.filename}`}>
        <img src={item.thumb} alt={item.filename} />
        <span className="media-badge">
          <ImageIcon size={11} /> tap for full quality
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
            <Lock size={18} />
            <span>{failed ? "Failed — tap to retry" : "Tap to decrypt"}</span>
            <span style={DIM}>
              {item.previewKind} · {formatBytes(item.size)}
            </span>
          </>
        )}
      </span>
    </button>
  )
}

const AUTO_DECRYPT_AUDIO_BYTES = 2 * 1024 * 1024

// Minimal one-tap voice player: play/pause button, draggable progress bar and
// a time readout. Replaces the old two-step flow (tap to decrypt, then tap the
// native controls again to actually play).
function VoicePlayer({ src }: { src: string }) {
  const ref = useRef<HTMLAudioElement | null>(null)
  const [playing, setPlaying] = useState(false)
  const [pos, setPos] = useState(0)
  const [dur, setDur] = useState(0)

  useEffect(() => {
    const a = new Audio()
    a.preload = "metadata"
    a.src = src
    ref.current = a
    const onTime = () => {
      // Ignore the huge transient position used by the duration probe below.
      if (Number.isFinite(a.currentTime) && a.currentTime < 1e6) setPos(a.currentTime)
      if (Number.isFinite(a.duration) && a.duration < 1e6) setDur(a.duration)
    }
    const onMeta = () => {
      if (Number.isFinite(a.duration) && a.duration < 1e6) {
        setDur(a.duration)
        return
      }
      // MediaRecorder webm reports Infinity until the element is forced to
      // scan to the end once; seek far ahead, capture the real duration, reset.
      const fix = () => {
        a.removeEventListener("seeked", fix)
        if (Number.isFinite(a.duration) && a.duration < 1e6) setDur(a.duration)
        try {
          a.currentTime = 0
        } catch {
          /* ignore */
        }
      }
      a.addEventListener("seeked", fix)
      try {
        a.currentTime = 1e7
      } catch {
        a.removeEventListener("seeked", fix)
      }
    }
    const onEnd = () => {
      setPlaying(false)
      setPos(0)
      try {
        a.currentTime = 0
      } catch {
        /* ignore */
      }
    }
    const onPlay = () => setPlaying(true)
    const onPause = () => setPlaying(false)
    a.addEventListener("timeupdate", onTime)
    a.addEventListener("loadedmetadata", onMeta)
    a.addEventListener("durationchange", onTime)
    a.addEventListener("ended", onEnd)
    a.addEventListener("play", onPlay)
    a.addEventListener("pause", onPause)
    return () => {
      a.pause()
      a.removeEventListener("timeupdate", onTime)
      a.removeEventListener("loadedmetadata", onMeta)
      a.removeEventListener("durationchange", onTime)
      a.removeEventListener("ended", onEnd)
      a.removeEventListener("play", onPlay)
      a.removeEventListener("pause", onPause)
      a.removeAttribute("src")
      ref.current = null
    }
  }, [src])

  function toggle() {
    const a = ref.current
    if (!a) return
    if (a.paused) void a.play().catch(() => {})
    else a.pause()
  }

  function seek(e: React.ChangeEvent<HTMLInputElement>) {
    const a = ref.current
    if (!a) return
    const v = Number(e.target.value)
    try {
      a.currentTime = v
    } catch {
      /* ignore */
    }
    setPos(v)
  }

  return (
    <div style={VP_WRAP}>
      <button
        type="button"
        className="icon-btn"
        style={VP_BTN}
        onClick={toggle}
        aria-label={playing ? "Pause voice note" : "Play voice note"}
      >
        {playing ? <Pause size={16} /> : <Play size={16} />}
      </button>
      <input
        type="range"
        min={0}
        max={Math.max(dur, pos, 0.1)}
        step={0.1}
        value={pos}
        onChange={seek}
        style={VP_RANGE}
        aria-label="Seek within voice note"
      />
      <span style={VP_TIME}>
        {fmtSecs(pos)}
        {dur > 0 ? ` / ${fmtSecs(dur)}` : ""}
      </span>
    </div>
  )
}

function fmtSecs(s: number): string {
  const t = Math.max(0, Math.floor(s))
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`
}

const DIM = { color: "var(--text-faint)", fontSize: "11px" }
const AUDIO_TILE = {
  display: "flex",
  alignItems: "center",
  gap: "8px",
  padding: "8px 10px",
  minWidth: "220px",
  cursor: "default",
} as const
const AUDIO_ICON = { flex: "none", color: "var(--accent)" } as const
const AUDIO_LOADING = { display: "flex", alignItems: "center", gap: "8px" } as const
const AUDIO_RETRY = { fontSize: "12px", padding: "6px 10px" } as const
const VP_WRAP = { display: "flex", alignItems: "center", gap: "8px", flex: 1, minWidth: 0 } as const
const VP_BTN = { flex: "none" } as const
const VP_RANGE = { flex: 1, minWidth: "80px", accentColor: "var(--accent)" } as const
const VP_TIME = {
  flex: "none",
  fontSize: "11px",
  color: "var(--text-faint)",
  fontVariantNumeric: "tabular-nums" as const,
} as const
