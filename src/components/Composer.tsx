import { useEffect, useRef, useState } from "react"
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Flame,
  Loader2,
  Lock,
  Reply,
  SendHorizonal,
  Timer,
  Upload,
  X,
} from "lucide-react"
import type { SendOpts, UploadState } from "../lib/useRoom"
import type { ReplyRef } from "../lib/messages"
import { formatBytes } from "../lib/format"

interface ComposerProps {
  uploads: UploadState[]
  roomId: string
  replyTo: ReplyRef | null
  onCancelReply: () => void
  onSend: (text: string, opts?: SendOpts) => void
  onSendMedia: (files: File[], caption: string, opts?: SendOpts) => void
  onTyping: () => void
}

const TTL_OPTIONS = [
  { label: "Off", ms: 0 },
  { label: "10s", ms: 10_000 },
  { label: "1m", ms: 60_000 },
  { label: "5m", ms: 300_000 },
  { label: "1h", ms: 3_600_000 },
  { label: "1d", ms: 86_400_000 },
]

// Keep attachments to the media types the pipeline understands (image/video).
// Files with no reported type (some pastes) are allowed through.
function mediaFilesFrom(list: FileList | File[] | null | undefined): File[] {
  return Array.from(list ?? []).filter(
    (f) => !f.type || f.type.startsWith("image/") || f.type.startsWith("video/"),
  )
}

export function Composer({
  uploads,
  roomId,
  replyTo,
  onCancelReply,
  onSend,
  onSendMedia,
  onTyping,
}: ComposerProps) {
  const draftKey = `vanish.draft.${roomId}`
  const [text, setText] = useState(() => localStorage.getItem(`vanish.draft.${roomId}`) ?? "")
  const [files, setFiles] = useState<File[]>([])
  const [ttlIdx, setTtlIdx] = useState(0)
  const [burn, setBurn] = useState(false)
  const [justSent, setJustSent] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const busy = uploads.some((u) => u.status === "encrypting" || u.status === "uploading")
  const ttl = TTL_OPTIONS[ttlIdx]

  // Persist the draft per-room so a refresh or accidental tab close keeps it.
  useEffect(() => {
    if (text) localStorage.setItem(draftKey, text)
    else localStorage.removeItem(draftKey)
  }, [text, draftKey])

  // Focus the textarea when a reply is started.
  useEffect(() => {
    if (replyTo) taRef.current?.focus()
  }, [replyTo])

  function autosize() {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = "auto"
    ta.style.height = Math.min(ta.scrollHeight, 140) + "px"
  }

  // When the field is focused (the user taps to type), snap the conversation to
  // the latest messages so the on-screen keyboard doesn't leave the most recent
  // messages hidden above the fold.
  function scrollChatToLatest() {
    const scroller = document.querySelector(".messages")
    if (!(scroller instanceof HTMLElement)) return
    const toBottom = () => {
      scroller.scrollTop = scroller.scrollHeight
    }
    requestAnimationFrame(toBottom)
    // Re-pin once the keyboard has finished animating in and resized the view.
    window.setTimeout(toBottom, 250)
  }

  function flashSent() {
    setJustSent(true)
    setTimeout(() => setJustSent(false), 900)
  }

  function addFiles(list: FileList | File[] | null | undefined) {
    const picked = mediaFilesFrom(list)
    if (picked.length) setFiles((prev) => [...prev, ...picked])
  }

  function submit() {
    const t = text.trim()
    const opts: SendOpts = {
      ttlMs: ttl.ms > 0 ? ttl.ms : undefined,
      burn: burn || undefined,
      replyTo: replyTo ?? undefined,
    }
    if (files.length > 0) {
      onSendMedia(files, t, opts)
      setFiles([])
      setText("")
      finishSend()
    } else if (t) {
      onSend(t, opts)
      setText("")
      finishSend()
    }
    requestAnimationFrame(autosize)
  }

  function finishSend() {
    setBurn(false)
    onCancelReply()
    localStorage.removeItem(draftKey)
    flashSent()
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    addFiles(e.target.files)
    e.target.value = ""
  }

  // Paste an image straight from the clipboard (e.g. a screenshot).
  function onPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const pasted = mediaFilesFrom(e.clipboardData?.files)
    if (pasted.length) {
      e.preventDefault()
      addFiles(pasted)
    }
  }

  function onDragOver(e: React.DragEvent) {
    if (Array.from(e.dataTransfer?.types ?? []).includes("Files")) {
      e.preventDefault()
      setDragOver(true)
    }
  }

  function onDragLeave(e: React.DragEvent) {
    if (e.currentTarget === e.target) setDragOver(false)
  }

  function onDrop(e: React.DragEvent) {
    if (Array.from(e.dataTransfer?.types ?? []).includes("Files")) {
      e.preventDefault()
      setDragOver(false)
      addFiles(e.dataTransfer?.files)
    }
  }

  const canSend = (text.trim().length > 0 || files.length > 0) && !busy

  return (
    <div
      className={`composer${dragOver ? " drag-over" : ""}`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {dragOver && (
        <div className="composer-drop" style={DROP}>
          <Upload size={18} /> Drop to attach — encrypted before upload
        </div>
      )}
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

      {replyTo && (
        <div className="reply-bar">
          <Reply size={14} />
          <div className="reply-bar-body">
            <b>{replyTo.username}</b>
            <span>{replyTo.preview}</span>
          </div>
          <button className="icon-btn mini" aria-label="Cancel reply" onClick={onCancelReply}>
            <X size={14} />
          </button>
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
          tabIndex={-1}
          aria-hidden="true"
          onChange={onPick}
        />
        <textarea
          ref={taRef}
          className="textarea"
          rows={1}
          placeholder="Write an encrypted message…"
          value={text}
          onFocus={scrollChatToLatest}
          onChange={(e) => {
            setText(e.target.value)
            autosize()
            onTyping()
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
        <button
          type="button"
          className={`send-btn ${justSent ? "sent" : ""}`}
          onClick={submit}
          disabled={!canSend}
          title="Send"
          aria-label="Send message"
        >
          {justSent ? <Check size={19} /> : <SendHorizonal size={19} />}
        </button>
      </div>

      <div className="composer-tools">
        <button
          type="button"
          className={`chip-toggle ${ttl.ms > 0 ? "on" : ""}`}
          onClick={() => setTtlIdx((i) => (i + 1) % TTL_OPTIONS.length)}
          title="Disappearing timer — message self-destructs after this delay"
          aria-label="Disappearing timer"
        >
          <Timer size={13} /> {ttl.ms > 0 ? ttl.label : "Timer"}
        </button>
        <button
          type="button"
          className={`chip-toggle ${burn ? "on danger" : ""}`}
          onClick={() => setBurn((v) => !v)}
          title="Read once — disappears after someone reads it"
          aria-label="Read once"
          aria-pressed={burn}
        >
          <Flame size={13} /> Read once
        </button>
        <span className="composer-hint">
          <Lock size={11} /> Encrypted in your browser
        </span>
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
const DROP = {
  display: "flex",
  alignItems: "center",
  gap: "8px",
  justifyContent: "center",
  padding: "10px",
  marginBottom: "8px",
  border: "1px dashed var(--accent)",
  borderRadius: "12px",
  color: "var(--accent)",
  fontSize: "13px",
  background: "color-mix(in srgb, var(--accent) 10%, transparent)",
} as const
