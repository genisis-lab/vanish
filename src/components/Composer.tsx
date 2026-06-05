import { useRef, useState } from "react"
import { AlertCircle, CheckCircle2, Loader2, Lock, SendHorizonal, Upload, X } from "lucide-react"
import type { UploadState } from "../lib/useRoom"
import { formatBytes } from "../lib/format"

interface ComposerProps {
  uploads: UploadState[]
  onSend: (text: string) => void
  onSendMedia: (files: File[], caption: string) => void
  onTyping: () => void
}

export function Composer({ uploads, onSend, onSendMedia, onTyping }: ComposerProps) {
  const [text, setText] = useState("")
  const [files, setFiles] = useState<File[]>([])
  const taRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const busy = uploads.some((u) => u.status === "encrypting" || u.status === "uploading")

  function autosize() {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = "auto"
    ta.style.height = Math.min(ta.scrollHeight, 140) + "px"
  }

  function submit() {
    const t = text.trim()
    if (files.length > 0) {
      onSendMedia(files, t)
      setFiles([])
      setText("")
    } else if (t) {
      onSend(t)
      setText("")
    }
    requestAnimationFrame(autosize)
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(e.target.files ?? [])
    if (picked.length) setFiles((prev) => [...prev, ...picked])
    e.target.value = ""
  }

  const canSend = (text.trim().length > 0 || files.length > 0) && !busy

  return (
    <div className="composer">
      {uploads.length > 0 && (
        <div className="upload-status">
          {uploads.map((u) => (
            <div className="upload-item" key={u.id}>
              <UploadIcon status={u.status} />
              <span style={NAME}>{u.filename}</span>
              {u.status === "uploading" ? (
                <span className="bar">
                  <i style={barWidth(u.progress)} />
                </span>
              ) : (
                <span style={STATUS}>{statusLabel(u.status)}</span>
              )}
            </div>
          ))}
        </div>
      )}

      {files.length > 0 && (
        <div className="attach-preview">
          {files.map((f, i) => (
            <span className="pill" key={f.name + i}>
              {f.name} · {formatBytes(f.size)}
              <button
                className="icon-btn mini"
                aria-label={`Remove ${f.name}`}
                onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))}
              >
                <X size={13} />
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="composer-row">
        <button
          type="button"
          className="upload-btn"
          onClick={() => fileRef.current?.click()}
          title="Attach encrypted photo or video"
          aria-label="Attach encrypted photo or video"
        >
          {busy && <span className="ring" />}
          <Upload size={20} />
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*,video/*"
          multiple
          hidden
          onChange={onPick}
        />
        <textarea
          ref={taRef}
          className="textarea"
          rows={1}
          placeholder="Write an encrypted message…"
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            autosize()
            onTyping()
          }}
          onKeyDown={onKeyDown}
        />
        <button
          type="button"
          className="send-btn"
          onClick={submit}
          disabled={!canSend}
          title="Send"
          aria-label="Send message"
        >
          <SendHorizonal size={19} />
        </button>
      </div>
      <div className="hint" style={FOOT}>
        <Lock size={11} /> Encrypted in your browser · Enter to send, Shift+Enter for a new line
      </div>
    </div>
  )
}

function UploadIcon({ status }: { status: UploadState["status"] }) {
  if (status === "done") return <CheckCircle2 size={15} color="var(--ok)" />
  if (status === "failed") return <AlertCircle size={15} color="var(--danger)" />
  return <Loader2 size={15} className="spin-inline" />
}

function statusLabel(s: UploadState["status"]): string {
  switch (s) {
    case "encrypting":
      return "Encrypting…"
    case "uploading":
      return "Uploading…"
    case "done":
      return "Done"
    case "failed":
      return "Failed"
    default:
      return ""
  }
}

function barWidth(p: number) {
  return { width: Math.round(p * 100) + "%" }
}

const NAME = { flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }
const STATUS = { color: "var(--text-faint)" }
const FOOT = { display: "flex", alignItems: "center", gap: "5px", marginTop: "2px" }
