import { useEffect, useRef, useState } from "react"
import {
  AlertCircle,
  BarChart3,
  Check,
  CheckCircle2,
  Flame,
  Loader2,
  Lock,
  Mic,
  Reply,
  SendHorizonal,
  Square,
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

// Keep attachments to the media types the pipeline understands
// (image/video/audio). Files with no reported type (some pastes) are allowed.
function mediaFilesFrom(list: FileList | File[] | null | undefined): File[] {
  return Array.from(list ?? []).filter(
    (f) =>
      !f.type ||
      f.type.startsWith("image/") ||
      f.type.startsWith("video/") ||
      f.type.startsWith("audio/"),
  )
}

// Pick the best-supported container/codec for recorded voice notes.
function pickAudioMime(): string | undefined {
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") {
    return undefined
  }
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/mp4",
  ]
  for (const c of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(c)) return c
    } catch {
      /* ignore */
    }
  }
  return undefined
}

function extFor(mime: string): string {
  if (mime.includes("ogg")) return "ogg"
  if (mime.includes("mp4")) return "m4a"
  return "webm"
}

function formatSecs(s: number): string {
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, "0")}`
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
  const [recording, setRecording] = useState(false)
  const [recSecs, setRecSecs] = useState(0)
  const editorRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const recRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const streamRef = useRef<MediaStream | null>(null)
  const recTimer = useRef<number | null>(null)
  const recSecsRef = useRef(0)
  const discardRef = useRef(false)
  const busy = uploads.some((u) => u.status === "encrypting" || u.status === "uploading")
  const ttl = TTL_OPTIONS[ttlIdx]
  const supportsRecording =
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder !== "undefined"

  // Seed the contenteditable from the saved draft once, and when the room changes.
  useEffect(() => {
    const el = editorRef.current
    if (el && el.textContent !== text) el.textContent = text
    syncEditorEmpty()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId])

  // Persist the draft per-room so a refresh or accidental tab close keeps it.
  useEffect(() => {
    if (text) localStorage.setItem(draftKey, text)
    else localStorage.removeItem(draftKey)
    syncEditorEmpty()
  }, [text, draftKey])

  // Focus the editor when a reply is started.
  useEffect(() => {
    if (replyTo) editorRef.current?.focus()
  }, [replyTo])

  // Tear down any in-flight recording (and release the mic) on unmount.
  useEffect(() => {
    return () => {
      if (recTimer.current) clearInterval(recTimer.current)
      if (recRef.current && recRef.current.state !== "inactive") {
        discardRef.current = true
        try {
          recRef.current.stop()
        } catch {
          /* ignore */
        }
      }
      streamRef.current?.getTracks().forEach((t) => t.stop())
    }
  }, [])

  function syncEditorEmpty() {
    const el = editorRef.current
    if (!el) return
    const empty = (el.textContent ?? "").trim().length === 0
    el.dataset.empty = empty ? "true" : "false"
  }

  function readEditorText(): string {
    const raw = editorRef.current?.innerText ?? ""
    // contenteditable often leaves a trailing newline from its final block.
    return raw.replace(/\n$/, "")
  }

  function clearEditor() {
    const el = editorRef.current
    if (el) el.textContent = ""
    setText("")
    syncEditorEmpty()
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
    window.setTimeout(toBottom, 180)
  }

  function flashSent() {
    setJustSent(true)
    setTimeout(() => setJustSent(false), 900)
  }

  function addFiles(list: FileList | File[] | null | undefined) {
    const picked = mediaFilesFrom(list)
    if (picked.length) setFiles((prev) => [...prev, ...picked])
  }

  function releaseStream() {
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
  }

  async function startRecording() {
    if (recording || !supportsRecording) return
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      const mime = pickAudioMime()
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
      chunksRef.current = []
      discardRef.current = false
      rec.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data)
      }
      rec.onstop = () => {
        releaseStream()
        if (recTimer.current) {
          clearInterval(recTimer.current)
          recTimer.current = null
        }
        setRecording(false)
        setRecSecs(0)
        recSecsRef.current = 0
        if (discardRef.current || chunksRef.current.length === 0) return
        const type = rec.mimeType || mime || "audio/webm"
        const blob = new Blob(chunksRef.current, { type })
        const file = new File([blob], `voice-note-${Date.now()}.${extFor(type)}`, { type })
        addFiles([file])
      }
      recRef.current = rec
      rec.start()
      setRecording(true)
      setRecSecs(0)
      recSecsRef.current = 0
      recTimer.current = window.setInterval(() => {
        recSecsRef.current += 1
        setRecSecs(recSecsRef.current)
        if (recSecsRef.current >= 300) stopRecording() // 5-minute safety cap
      }, 1000)
    } catch {
      releaseStream()
      setRecording(false)
    }
  }

  function stopRecording() {
    const rec = recRef.current
    if (rec && rec.state !== "inactive") {
      try {
        rec.stop()
      } catch {
        /* ignore */
      }
    }
  }

  function cancelRecording() {
    discardRef.current = true
    stopRecording()
  }

  function submit() {
    const t = readEditorText().trim()
    const opts: SendOpts = {
      ttlMs: ttl.ms > 0 ? ttl.ms : undefined,
      burn: burn || undefined,
      replyTo: replyTo ?? undefined,
    }
    if (files.length > 0) {
      onSendMedia(files, t, opts)
      setFiles([])
      clearEditor()
      finishSend()
    } else if (t) {
      onSend(t, opts)
      clearEditor()
      finishSend()
    }
  }

  // Build an encrypted poll via two quick prompts (matching the app's existing
  // prompt-based flows). The question and options are end-to-end encrypted;
  // votes are encrypted reactions.
  function createPoll() {
    const q = window.prompt("Poll question:")?.trim()
    if (!q) return
    const raw = window.prompt("Options — separate with commas (2 to 6):")
    if (raw === null) return
    const options = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 6)
    if (options.length < 2) {
      window.alert("A poll needs at least 2 options.")
      return
    }
    onSend(q, {
      ttlMs: ttl.ms > 0 ? ttl.ms : undefined,
      burn: burn || undefined,
      replyTo: replyTo ?? undefined,
      poll: { question: q, options },
    })
    finishSend()
  }

  function finishSend() {
    setBurn(false)
    onCancelReply()
    localStorage.removeItem(draftKey)
    flashSent()
  }

  function onEditorInput() {
    const next = readEditorText()
    setText(next)
    syncEditorEmpty()
    onTyping()
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    addFiles(e.target.files)
    e.target.value = ""
  }

  // Paste an image straight from the clipboard (e.g. a screenshot), or paste
  // plain text only so rich clipboard HTML never enters the encrypted draft box.
  function onPaste(e: React.ClipboardEvent<HTMLDivElement>) {
    const pasted = mediaFilesFrom(e.clipboardData?.files)
    if (pasted.length) {
      e.preventDefault()
      addFiles(pasted)
      return
    }
    const plain = e.clipboardData?.getData("text/plain")
    if (plain) {
      e.preventDefault()
      insertPlainText(plain)
      onEditorInput()
    }
  }

  function insertPlainText(value: string) {
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0) return
    sel.deleteFromDocument()
    const node = document.createTextNode(value)
    const range = sel.getRangeAt(0)
    range.insertNode(node)
    range.setStartAfter(node)
    range.collapse(true)
    sel.removeAllRanges()
    sel.addRange(range)
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

      {recording && (
        <div className="rec-bar" style={REC_BAR}>
          <span style={REC_DOT} aria-hidden="true" />
          <span>Recording voice note… {formatSecs(recSecs)}</span>
          <span style={SPACER} />
          <button className="icon-btn mini" aria-label="Discard recording" onClick={cancelRecording}>
            <X size={15} />
          </button>
          <button className="btn btn-primary" onClick={stopRecording}>
            <Square size={14} /> Stop & attach
          </button>
        </div>
      )}

      <div className="composer-row">
        <button
          type="button"
          className="upload-btn"
          onClick={() => fileRef.current?.click()}
          title="Attach encrypted photo or video"
          aria-label="Attach encrypted photo or video"
          disabled={recording}
        >
          {busy && <span className="ring" />}
          <Upload size={20} />
        </button>
        {supportsRecording && (
          <button
            type="button"
            className={`upload-btn ${recording ? "recording" : ""}`}
            onClick={recording ? stopRecording : startRecording}
            title={recording ? "Stop recording" : "Record an encrypted voice note"}
            aria-label={recording ? "Stop recording" : "Record an encrypted voice note"}
          >
            {recording ? <Square size={20} /> : <Mic size={20} />}
          </button>
        )}
        <input
          ref={fileRef}
          type="file"
          accept="image/*,video/*,audio/*"
          multiple
          hidden
          tabIndex={-1}
          aria-hidden="true"
          onChange={onPick}
        />
        <div
          ref={editorRef}
          className="textarea composer-editor"
          role="textbox"
          aria-label="Encrypted message"
          aria-multiline="true"
          contentEditable={!busy}
          data-placeholder="Write an encrypted message…"
          data-empty={text.trim().length === 0 ? "true" : "false"}
          suppressContentEditableWarning
          onFocus={scrollChatToLatest}
          onInput={onEditorInput}
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
        <button
          type="button"
          className="chip-toggle"
          onClick={createPoll}
          title="Create an encrypted poll — question, options and votes stay end-to-end encrypted"
          aria-label="Create encrypted poll"
          disabled={recording}
        >
          <BarChart3 size={13} /> Poll
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
const SPACER = { flex: 1 } as const
const REC_BAR = {
  display: "flex",
  alignItems: "center",
  gap: "8px",
  padding: "8px 10px",
  marginBottom: "8px",
  border: "1px solid var(--danger)",
  borderRadius: "12px",
  fontSize: "13px",
  background: "color-mix(in srgb, var(--danger) 10%, transparent)",
} as const
const REC_DOT = {
  width: "10px",
  height: "10px",
  borderRadius: "999px",
  background: "var(--danger)",
  flex: "none",
  animation: "pulse 1s ease-in-out infinite",
} as const
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
