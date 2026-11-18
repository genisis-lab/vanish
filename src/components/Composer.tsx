import { useEffect, useId, useMemo, useRef, useState } from "react"
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Flame,
  Loader2,
  Lock,
  Mic,
  Pencil,
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
import { plainText } from "../lib/richText"
import {
  CHAT_TIMER_OPTIONS_MS,
  formatTtlShort,
  isNeverExpireTtl,
  MAX_MESSAGE_TTL_MS,
  NEVER_EXPIRE_TTL_MS,
} from "@shared/constants"

interface ComposerProps {
  uploads: UploadState[]
  roomId: string
  /** The room's disappearing timer, shared by everyone in the chat. */
  defaultTtlMs: number
  defaultBurn: boolean
  /** Change the chat-wide timer; resolves once the server has applied it. */
  onChangeTimer: (ttlMs: number, opts?: { keepExisting?: boolean }) => Promise<void>
  /**
   * Messages already in the chat that are still counting down (not read-once,
   * not deleted). Switching to "Never" asks whether to keep these too.
   */
  keepableCount?: number
  /** The owner has locked the timer and this device isn't the owner. */
  timerLocked?: boolean
  onCancelUpload: (messageId: string) => void
  replyTo: ReplyRef | null
  onCancelReply: () => void
  onSend: (text: string, opts?: SendOpts) => void
  onSendMedia: (files: File[], caption: string, opts?: SendOpts) => void
  onTyping: () => void
  /** A message of mine being edited here. While set, sending saves the edit. */
  editing?: EditTarget | null
  onSaveEdit?: (text: string) => void
  onCancelEdit?: () => void
  /** Up arrow in an empty box edits my latest message. Returns false if there is none. */
  onEditLast?: () => boolean
  /** Names that can be @mentioned, offered as suggestions while typing. */
  mentionNames?: string[]
}

export interface EditTarget {
  id: string
  text: string
}

const MAX_SUGGESTIONS = 6
// "@" at the start or after a non-word character, then up to 32 characters of
// a name (names can have spaces), ending at the caret.
const MENTION_QUERY = /(^|[^\p{L}\p{N}_])@([^@\n]{0,32})$/u
const WORD_CHAR = /[\p{L}\p{N}_]/u

interface MentionSpot {
  node: Text
  start: number
  end: number
  query: string
}

/** The "@name" being typed just before the caret in the editor, if any. */
function mentionAtCaret(editor: HTMLElement): MentionSpot | null {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return null
  const node = sel.focusNode
  if (!node || node.nodeType !== Node.TEXT_NODE || !editor.contains(node)) return null
  const text = node as Text
  const before = text.data.slice(0, sel.focusOffset)
  const m = MENTION_QUERY.exec(before)
  if (!m) return null
  const start = m.index + m[1].length
  // An "@" at the start of this text node may still follow a word in the one before.
  if (start === 0) {
    const prev = text.previousSibling?.textContent ?? ""
    if (WORD_CHAR.test(prev.slice(-1))) return null
  }
  return { node: text, start, end: sel.focusOffset, query: m[2] }
}

function placeCaretAtEnd(el: HTMLElement) {
  const sel = window.getSelection()
  if (!sel) return
  const range = document.createRange()
  range.selectNodeContents(el)
  range.collapse(false)
  sel.removeAllRanges()
  sel.addRange(range)
}

// The timer is chat-wide: picking one changes it for everyone and posts a
// notice in the chat. A room created with a value not in the list (older rooms)
// still shows it, so the select never lies about the current timer.
function timerOptions(current: number): number[] {
  if (CHAT_TIMER_OPTIONS_MS.includes(current)) return CHAT_TIMER_OPTIONS_MS
  const timed = [...CHAT_TIMER_OPTIONS_MS.filter((ms) => !isNeverExpireTtl(ms)), current]
  return [...timed.sort((a, b) => a - b), NEVER_EXPIRE_TTL_MS]
}

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
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"]
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
  defaultTtlMs,
  defaultBurn,
  onChangeTimer,
  keepableCount = 0,
  timerLocked = false,
  onCancelUpload,
  replyTo,
  onCancelReply,
  onSend,
  onSendMedia,
  onTyping,
  editing = null,
  onSaveEdit,
  onCancelEdit,
  onEditLast,
  mentionNames,
}: ComposerProps) {
  const draftKey = `vanish.draft.${roomId}`
  const [text, setText] = useState("")
  const [files, setFiles] = useState<File[]>([])
  // Optimistic choice while the server applies it; cleared once it settles.
  const [pendingTtl, setPendingTtl] = useState<number | null>(null)
  // Switching to "Never" with messages still counting down: ask about those.
  const [askKeep, setAskKeep] = useState(false)
  const [burn, setBurn] = useState(defaultBurn)
  const [justSent, setJustSent] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [recordError, setRecordError] = useState("")
  const [startingRecording, setStartingRecording] = useState(false)
  const [voice, setVoice] = useState<File | null>(null)
  const [voiceUrl, setVoiceUrl] = useState<string | null>(null)
  const mounted = useRef(true)
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
  // What was in the box before an edit started, put back when the edit ends.
  const draftBeforeEdit = useRef<string | null>(null)
  const [mention, setMention] = useState<{ query: string; index: number } | null>(null)
  const mentionSpot = useRef<MentionSpot | null>(null)
  const mentionListId = useId()
  const busy = uploads.some((u) => u.status === "encrypting" || u.status === "uploading")
  const effectiveTtl = pendingTtl ?? defaultTtlMs
  const alreadyNever = isNeverExpireTtl(defaultTtlMs)
  // Read-once messages always expire; "Never" caps them at the longest timer.
  const burnLabel = formatTtlShort(
    isNeverExpireTtl(effectiveTtl) ? MAX_MESSAGE_TTL_MS : effectiveTtl,
  )
  useEffect(() => {
    setBurn(defaultBurn)
  }, [defaultBurn])
  useEffect(() => {
    if (!voice) {
      setVoiceUrl(null)
      return
    }
    const url = URL.createObjectURL(voice)
    setVoiceUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [voice])
  const supportsRecording =
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder !== "undefined"

  // Seed/reset the contenteditable when the room changes and clear legacy
  // plaintext drafts that older builds may have left in localStorage.
  useEffect(() => {
    try {
      localStorage.removeItem(draftKey)
    } catch {
      /* storage may be unavailable */
    }
    setText("")
    const el = editorRef.current
    if (el) el.textContent = ""
    syncEditorEmpty()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId])

  // Keep the placeholder state in sync without persisting plaintext drafts.
  useEffect(() => {
    syncEditorEmpty()
  }, [text])

  // Focus the editor when a reply is started.
  useEffect(() => {
    if (replyTo) editorRef.current?.focus()
  }, [replyTo])

  // Editing puts the message's text in the box; finishing or cancelling puts
  // back whatever was being typed before.
  const editingId = editing?.id ?? null
  useEffect(() => {
    const el = editorRef.current
    if (!el) return
    if (editing) {
      if (draftBeforeEdit.current === null) draftBeforeEdit.current = readEditorText()
      el.textContent = editing.text
      setText(editing.text)
      syncEditorEmpty()
      el.focus()
      placeCaretAtEnd(el)
    } else if (draftBeforeEdit.current !== null) {
      const draft = draftBeforeEdit.current
      draftBeforeEdit.current = null
      el.textContent = draft
      setText(draft)
      syncEditorEmpty()
    }
    closeMentions()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingId])

  const suggestions = useMemo(() => {
    if (!mention || !mentionNames?.length) return []
    const q = mention.query.toLowerCase()
    return mentionNames
      .filter((name) => name.toLowerCase().startsWith(q))
      .sort((a, b) => a.localeCompare(b))
      .slice(0, MAX_SUGGESTIONS)
  }, [mention?.query, mentionNames])
  const activeSuggestion = mention && suggestions.length > 0 ? mention.index % suggestions.length : -1

  // Tear down any in-flight recording (and release the mic) on unmount.
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
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
    if (recording || startingRecording || voice || !supportsRecording) return
    setRecordError("")
    setStartingRecording(true)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      if (!mounted.current) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }
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
        if (mounted.current) setVoice(file)
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
    } catch (error) {
      releaseStream()
      if (mounted.current) {
        setRecording(false)
        setRecordError(
          error instanceof DOMException && error.name === "NotAllowedError"
            ? "Microphone access was denied. Allow it in your browser's site settings, then try again."
            : error instanceof DOMException && error.name === "NotFoundError"
              ? "No microphone was found. Connect one and try again."
              : "Could not start recording. Check that your microphone is available and try again.",
        )
      }
    } finally {
      if (mounted.current) setStartingRecording(false)
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

  function applyTimer(next: number, keepExisting: boolean) {
    setAskKeep(false)
    setPendingTtl(next)
    const change = keepExisting ? onChangeTimer(next, { keepExisting: true }) : onChangeTimer(next)
    void change.finally(() => {
      if (mounted.current) setPendingTtl(null)
    })
  }

  function cancelKeepPrompt() {
    setAskKeep(false)
    setPendingTtl(null)
  }

  function closeMentions() {
    mentionSpot.current = null
    setMention(null)
  }

  // Look for an "@name" being typed at the caret and offer matching names.
  function updateMentions() {
    const el = editorRef.current
    const spot = el && mentionNames?.length ? mentionAtCaret(el) : null
    mentionSpot.current = spot
    setMention((prev) =>
      spot ? { query: spot.query, index: prev?.query === spot.query ? prev.index : 0 } : null,
    )
  }

  function insertMention(name: string) {
    const el = editorRef.current
    const spot = mentionSpot.current
    if (!el || !spot || !spot.node.isConnected || !el.contains(spot.node)) return closeMentions()
    if (spot.node.data.slice(spot.start, spot.end) !== `@${spot.query}`) return closeMentions()
    const addSpace = !/^\s/.test(spot.node.data.slice(spot.end))
    spot.node.replaceData(spot.start, spot.end - spot.start, `@${name}${addSpace ? " " : ""}`)
    el.focus()
    const range = document.createRange()
    range.setStart(spot.node, Math.min(spot.start + name.length + 2, spot.node.length))
    range.collapse(true)
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)
    closeMentions()
    setText(readEditorText())
    syncEditorEmpty()
    if (!editing) onTyping()
  }

  function submit() {
    if (editing) {
      const t = readEditorText().trim()
      if (t) onSaveEdit?.(t)
      return
    }
    if (busy || recording || startingRecording) return
    const t = readEditorText().trim()
    const opts: SendOpts = {
      burn,
      replyTo: replyTo ?? undefined,
    }
    if (files.length > 0 || voice) {
      onSendMedia(voice ? [...files, voice] : files, t, opts)
      setVoice(null)
      setFiles([])
      clearEditor()
      finishSend()
    } else if (t) {
      onSend(t, opts)
      clearEditor()
      finishSend()
    }
  }

  function finishSend() {
    setBurn(defaultBurn)
    onCancelReply()
    try {
      localStorage.removeItem(draftKey)
    } catch {
      /* unavailable storage */
    }
    flashSent()
  }

  function onEditorInput() {
    const next = readEditorText()
    setText(next)
    syncEditorEmpty()
    updateMentions()
    if (!editing) onTyping()
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.nativeEvent.isComposing) return
    if (activeSuggestion >= 0 && mention) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault()
        const step = e.key === "ArrowDown" ? 1 : suggestions.length - 1
        setMention({ ...mention, index: (activeSuggestion + step) % suggestions.length })
        return
      }
      if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
        e.preventDefault()
        insertMention(suggestions[activeSuggestion])
        return
      }
      if (e.key === "Escape") {
        e.preventDefault()
        closeMentions()
        return
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      submit()
      return
    }
    if (e.key === "Escape") {
      if (editing) {
        e.preventDefault()
        onCancelEdit?.()
      } else if (replyTo) {
        e.preventDefault()
        onCancelReply()
      }
      return
    }
    // Up arrow in an empty box edits my latest message, as in most chat apps.
    if (
      e.key === "ArrowUp" &&
      !editing &&
      !e.shiftKey &&
      !e.altKey &&
      !e.ctrlKey &&
      !e.metaKey &&
      readEditorText().trim() === "" &&
      files.length === 0 &&
      !voice &&
      onEditLast?.()
    ) {
      e.preventDefault()
    }
  }

  // Close suggestions when the box loses focus, a moment later so a tap on a
  // suggestion still lands on browsers that move focus before the click.
  function onEditorBlur() {
    window.setTimeout(() => {
      if (document.activeElement !== editorRef.current) closeMentions()
    }, 150)
  }

  function onKeyUp(e: React.KeyboardEvent<HTMLDivElement>) {
    // Moving the caret can step into or out of an "@name".
    if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) updateMentions()
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

  const canSend = editing
    ? text.trim().length > 0
    : (text.trim().length > 0 || files.length > 0 || !!voice) &&
      !busy &&
      !recording &&
      !startingRecording

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
              {(u.status === "uploading" || u.status === "encrypting") && (
                <button
                  className="btn"
                  onClick={() => onCancelUpload(u.messageId)}
                  aria-label={`Cancel upload ${u.filename}`}
                >
                  Cancel
                </button>
              )}
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

      {editing && (
        <div className="reply-bar edit-bar">
          <Pencil size={14} />
          <div className="reply-bar-body">
            <b>Editing message</b>
            <span>{plainText(editing.text)}</span>
          </div>
          <button className="icon-btn mini" aria-label="Cancel editing" onClick={onCancelEdit}>
            <X size={14} />
          </button>
        </div>
      )}

      {replyTo && !editing && (
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

      {files.length > 0 && !editing && (
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

      {recordError && (
        <p role="alert" className="inline-error">
          {recordError}
        </p>
      )}
      {askKeep && (
        <div className="keep-prompt" role="group" aria-label="Keep existing messages">
          <span>
            {alreadyNever
              ? `Keep the ${keepableCount} older ${keepableCount === 1 ? "message" : "messages"} that ${keepableCount === 1 ? "is" : "are"} still counting down?`
              : `Stop disappearing messages. Also keep the ${keepableCount} ${keepableCount === 1 ? "message" : "messages"} already here?`}
          </span>
          <div className="keep-prompt-actions">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => applyTimer(NEVER_EXPIRE_TTL_MS, true)}
            >
              {alreadyNever ? "Keep them" : "Keep them too"}
            </button>
            {!alreadyNever && (
              <button
                type="button"
                className="btn"
                onClick={() => applyTimer(NEVER_EXPIRE_TTL_MS, false)}
              >
                Only new messages
              </button>
            )}
            <button type="button" className="btn btn-ghost" onClick={cancelKeepPrompt}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {voice && voiceUrl && !editing && (
        <div className="voice-preview">
          <span>Preview voice note</span>
          <audio controls src={voiceUrl} aria-label="Voice note preview" />
          <button className="btn" onClick={() => setVoice(null)} disabled={busy}>
            Discard voice note
          </button>
          <button className="btn btn-primary" onClick={submit} disabled={!canSend}>
            Send voice note
          </button>
        </div>
      )}
      {recording && (
        <div className="rec-bar" style={REC_BAR}>
          <span style={REC_DOT} aria-hidden="true" />
          <span>Recording voice note… {formatSecs(recSecs)}</span>
          <span style={SPACER} />
          <button
            className="icon-btn mini"
            aria-label="Discard recording"
            onClick={cancelRecording}
          >
            <X size={15} />
          </button>
          <button className="btn btn-primary" onClick={stopRecording}>
            <Square size={14} /> Stop & preview
          </button>
        </div>
      )}

      {activeSuggestion >= 0 && (
        <div className="mention-pop" id={mentionListId} role="listbox" aria-label="Mention someone">
          {suggestions.map((name, i) => (
            <button
              key={name}
              id={`${mentionListId}-${i}`}
              type="button"
              role="option"
              aria-selected={i === activeSuggestion}
              className={i === activeSuggestion ? "active" : undefined}
              // Keep focus (and the caret) in the message box.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => insertMention(name)}
            >
              @{name}
            </button>
          ))}
        </div>
      )}

      <div className="composer-row">
        {!editing && (
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
        )}
        {supportsRecording && !editing && (
          <button
            type="button"
            className={`upload-btn ${recording ? "recording" : ""}`}
            disabled={startingRecording || !!voice || busy}
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
          // Typing stays possible while an attachment uploads; sending waits for it.
          contentEditable={!!editing || !recording}
          data-placeholder="Write an encrypted message…"
          data-empty={text.trim().length === 0 ? "true" : "false"}
          aria-autocomplete="list"
          aria-controls={activeSuggestion >= 0 ? mentionListId : undefined}
          aria-activedescendant={
            activeSuggestion >= 0 ? `${mentionListId}-${activeSuggestion}` : undefined
          }
          suppressContentEditableWarning
          onFocus={scrollChatToLatest}
          onBlur={onEditorBlur}
          onInput={onEditorInput}
          onKeyDown={onKeyDown}
          onKeyUp={onKeyUp}
          onPaste={onPaste}
        />
        <button
          type="button"
          className={`send-btn ${justSent ? "sent" : ""}`}
          onClick={submit}
          disabled={!canSend}
          title={editing ? "Save edit" : "Send"}
          aria-label={editing ? "Save edit" : "Send message"}
        >
          {justSent || editing ? <Check size={19} /> : <SendHorizonal size={19} />}
        </button>
      </div>

      <div className="composer-tools">
        <label className="timer-select">
          <Timer size={13} />
          <span className="sr-only">Disappearing timer</span>
          <select
            aria-label="Disappearing timer"
            title={
              timerLocked
                ? "Only the room owner can change the timer"
                : "Disappearing timer for everyone in this chat"
            }
            value={String(effectiveTtl)}
            disabled={pendingTtl !== null || timerLocked || askKeep}
            onChange={(e) => {
              const next = Number(e.target.value)
              if (isNeverExpireTtl(next) && keepableCount > 0) {
                // Ask first; the select shows "Never" while the choice is open.
                setPendingTtl(next)
                setAskKeep(true)
                return
              }
              if (next === defaultTtlMs) return
              applyTimer(next, false)
            }}
          >
            {timerOptions(defaultTtlMs).map((ms) => (
              <option key={ms} value={String(ms)}>
                {formatTtlShort(ms)}
              </option>
            ))}
          </select>
        </label>
        {isNeverExpireTtl(defaultTtlMs) && keepableCount > 0 && !timerLocked && !askKeep && (
          <button
            type="button"
            className="chip-toggle"
            onClick={() => setAskKeep(true)}
            title="Some older messages are still counting down from before the timer was turned off"
          >
            Keep {keepableCount} older
          </button>
        )}
        {!editing && (
          <button
            type="button"
            className={`chip-toggle ${burn ? "on danger" : ""}`}
            onClick={() => setBurn((v) => !v)}
            title={`Read once — expires after ${burnLabel} if unopened`}
            aria-label="Read once"
            aria-pressed={burn}
          >
            <Flame size={13} /> Read once
          </button>
        )}
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

const NAME = {
  flex: 1,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap" as const,
}
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
