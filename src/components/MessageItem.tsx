import { memo, useEffect, useRef, useState } from "react"
import { Check, CheckCheck, Clock, Flame, Reply, RotateCw, ShieldAlert, SmilePlus } from "lucide-react"
import type { RoomSession } from "../lib/session"
import type { DecryptedMessage } from "../lib/messages"
import type { MediaManifestItem } from "../lib/media"
import { formatCountdown, formatTime, hueFromString } from "../lib/format"
import { MediaTile } from "./MediaTile"

const QUICK_EMOJI = ["\u{1F525}", "\u2764\uFE0F", "\u{1F44D}", "\u{1F602}", "\u{1F62E}", "\u{1F622}"]

interface Props {
  session: RoomSession
  msg: DecryptedMessage
  showWho: boolean
  selecting: boolean
  selected: boolean
  seen: boolean
  onToggleSelect: (id: string) => void
  onReact: (id: string, emoji: string) => void
  onReply: (msg: DecryptedMessage) => void
  onOpenMedia: (item: MediaManifestItem) => void
  onRetry?: (id: string) => void
  onJumpTo?: (id: string) => void
}

// Re-render once per second while a message carries a live disappearing-timer,
// so the countdown in the footer ticks down visibly instead of only updating
// when the surrounding list happens to re-render.
function useSecondTick(active: boolean) {
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => setTick((n) => (n + 1) % 3600), 1000)
    return () => clearInterval(t)
  }, [active])
}

function MessageItemInner({
  session,
  msg,
  showWho,
  selecting,
  selected,
  seen,
  onToggleSelect,
  onReact,
  onReply,
  onOpenMedia,
  onRetry,
  onJumpTo,
}: Props) {
  const [picker, setPicker] = useState(false)
  const [actions, setActions] = useState(false)
  const [dragX, setDragX] = useState(0)
  const dragStartX = useRef<number | null>(null)
  const pickerRef = useRef<HTMLDivElement>(null)
  useSecondTick(msg.kind !== "system" && msg.expiresAt != null)

  // Close the reaction picker when tapping/clicking anywhere outside it (but
  // not on the toggle button, which manages its own open/close).
  useEffect(() => {
    if (!picker) return
    const onDocPointerDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement | null
      if (!t) return
      if (pickerRef.current?.contains(t)) return
      if (t.closest("[data-emoji-toggle]")) return
      setPicker(false)
    }
    document.addEventListener("pointerdown", onDocPointerDown)
    return () => document.removeEventListener("pointerdown", onDocPointerDown)
  }, [picker])

  // Close the tap-revealed quick actions when tapping elsewhere. The message's
  // own bubble is excluded so its click handler can toggle them, and the tools
  // themselves are excluded so their buttons still register.
  useEffect(() => {
    if (!actions) return
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement | null
      if (!t) return
      if (t.closest("[data-msg-actions]")) return
      if (t.closest(`[data-mid="${msg.id}"]`)) return
      setActions(false)
    }
    document.addEventListener("pointerdown", onDown)
    return () => document.removeEventListener("pointerdown", onDown)
  }, [actions, msg.id])

  if (msg.kind === "system") {
    return <div className="sys-line">{msg.text}</div>
  }

  const hue = hueFromString(msg.username)
  const whoStyle = { color: `hsl(${hue} 55% 60%)` }
  const ttl = formatCountdown(msg.expiresAt)

  function click() {
    if (selecting) {
      onToggleSelect(msg.id)
      return
    }
    // On touch devices (no hover) tapping a message reveals its quick actions;
    // on pointer devices the hover affordance handles it, so we leave taps free
    // for text selection.
    if (
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(hover: none)").matches
    ) {
      setActions((v) => !v)
    }
  }

  // Touch swipe-to-reply: drag a bubble toward its owner's side past a small
  // threshold to start a reply. Disabled while multi-selecting.
  function onTouchStart(e: React.TouchEvent) {
    if (selecting) return
    dragStartX.current = e.touches[0].clientX
  }
  function onTouchMove(e: React.TouchEvent) {
    if (dragStartX.current === null) return
    const dx = e.touches[0].clientX - dragStartX.current
    const dir = msg.mine ? Math.min(0, dx) : Math.max(0, dx)
    setDragX(Math.max(-90, Math.min(90, dir)))
  }
  function onTouchEnd() {
    if (dragStartX.current === null) return
    dragStartX.current = null
    if (Math.abs(dragX) > 55) onReply(msg)
    setDragX(0)
  }

  const tools = !selecting && (
    <div className={`msg-tools ${actions ? "open" : ""}`} data-msg-actions>
      <button
        className="icon-btn mini"
        aria-label="Reply"
        onClick={() => {
          onReply(msg)
          setActions(false)
        }}
      >
        <Reply size={15} />
      </button>
      <button
        className="icon-btn mini"
        aria-label="Add reaction"
        data-emoji-toggle
        onClick={() => {
          setPicker((v) => !v)
          setActions(false)
        }}
      >
        <SmilePlus size={15} />
      </button>
    </div>
  )

  return (
    <div
      className={`msg ${msg.mine ? "mine" : ""} ${selected ? "selected" : ""}`}
      data-mid={msg.id}
    >
      {showWho && !msg.mine && (
        <div className="who" style={whoStyle}>
          {msg.username}
        </div>
      )}

      <div
        className="msg-row"
        style={{
          ...ROW,
          transform: dragX ? `translateX(${dragX}px)` : undefined,
          transition: dragStartX.current === null ? "transform .18s ease" : "none",
        }}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
      >
        <div className="bubble" onClick={click} role={selecting ? "button" : undefined}>
          {msg.replyTo && (
            <div
              className="quote"
              role="button"
              style={onJumpTo ? QUOTE_CLICK : undefined}
              onClick={(e) => {
                e.stopPropagation()
                if (msg.replyTo) onJumpTo?.(msg.replyTo.id)
              }}
            >
              <b>{msg.replyTo.username}</b>
              <span>{msg.replyTo.preview}</span>
            </div>
          )}
          {msg.text && <span>{msg.text}</span>}
          {msg.items && msg.items.length > 0 && (
            <div className="media-grid">
              {msg.items.map((it) => (
                <MediaTile key={it.objectKey} session={session} item={it} onOpen={onOpenMedia} />
              ))}
            </div>
          )}
        </div>

        {tools}
      </div>

      {picker && (
        <div className="emoji-pop" ref={pickerRef}>
          {QUICK_EMOJI.map((e) => (
            <button
              key={e}
              onClick={() => {
                onReact(msg.id, e)
                setPicker(false)
              }}
            >
              {e}
            </button>
          ))}
        </div>
      )}

      {msg.reactions.length > 0 && (
        <div className="react-row">
          {msg.reactions.map((r) => (
            <button
              key={r.emoji}
              className={`chip ${r.mine ? "mine" : ""}`}
              title={r.users.join(", ")}
              onClick={() => onReact(msg.id, r.emoji)}
            >
              {r.emoji} {r.count}
            </button>
          ))}
        </div>
      )}

      <div className="foot">
        <span>{formatTime(msg.createdAt)}</span>
        {msg.burn && (
          <span className="burn-tag">
            <Flame size={10} /> Read once
          </span>
        )}
        {ttl && (
          <span className="ttl">
            <Clock size={10} /> {ttl}
          </span>
        )}
        {msg.mine && <SendState failed={msg.failed} pending={msg.pending} seen={seen} />}
        {msg.mine && msg.failed && onRetry && (
          <button className="retry-btn" onClick={() => onRetry(msg.id)} aria-label="Retry sending">
            <RotateCw size={11} /> Retry
          </button>
        )}
        {(msg.keyChanged || msg.verified === "bad") && (
          <span
            className="state-failed"
            title={
              msg.keyChanged
                ? "This sender's signing key changed since their first message this session — it may not be the same person."
                : "This message's signature could not be verified — it may have been forged or tampered with."
            }
          >
            <ShieldAlert size={11} /> {msg.keyChanged ? "Key changed" : "Unverified"}
          </span>
        )}
      </div>
    </div>
  )
}

function SendState({
  failed,
  pending,
  seen,
}: {
  failed?: boolean
  pending?: boolean
  seen: boolean
}) {
  if (failed) return <span className="state-failed">Failed</span>
  if (pending) return <span className="state-pending">Sending…</span>
  if (seen)
    return (
      <span className="state-seen" title="Seen">
        <CheckCheck size={13} />
      </span>
    )
  return (
    <span className="state-sent" title="Sent">
      <Check size={13} />
    </span>
  )
}

const ROW = { display: "flex", alignItems: "center", gap: "4px" }
const QUOTE_CLICK = { cursor: "pointer" }

export const MessageItem = memo(MessageItemInner)
