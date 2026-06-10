import { memo, useEffect, useRef, useState } from "react"
import {
  Ban,
  Check,
  CheckCheck,
  Clock,
  CornerDownRight,
  Flame,
  Pencil,
  Reply,
  RotateCw,
  ShieldAlert,
  SmilePlus,
  Trash2,
} from "lucide-react"
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
  /** Names of peers who have read up to this message (only set for my latest). */
  seenByNames?: string[]
  /** How many messages reply to this one. */
  replyCount?: number
  /** Id of the first reply, for the jump-to-thread chip. */
  firstReplyId?: string
  onToggleSelect: (id: string) => void
  onReact: (id: string, emoji: string) => void
  onReply: (msg: DecryptedMessage) => void
  onEdit?: (msg: DecryptedMessage) => void
  onDelete?: (msg: DecryptedMessage) => void
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
  seenByNames,
  replyCount = 0,
  firstReplyId,
  onToggleSelect,
  onReact,
  onReply,
  onEdit,
  onDelete,
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

  // Edit is offered for my own plain-text messages; delete for any of my own
  // messages. Both require the message to be acked (not pending/failed) and not
  // already deleted.
  const canModify = msg.mine && !msg.deleted && !msg.pending && !msg.failed

  const tools = !selecting && !msg.deleted && (
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
      {canModify && msg.kind === "text" && onEdit && (
        <button
          className="icon-btn mini"
          aria-label="Edit message"
          onClick={() => {
            onEdit(msg)
            setActions(false)
          }}
        >
          <Pencil size={15} />
        </button>
      )}
      {canModify && onDelete && (
        <button
          className="icon-btn mini"
          aria-label="Delete message"
          onClick={() => {
            onDelete(msg)
            setActions(false)
          }}
        >
          <Trash2 size={15} />
        </button>
      )}
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
          {msg.deleted ? (
            <span className="deleted-msg" style={DELETED}>
              <Ban size={13} /> This message was deleted
            </span>
          ) : (
            <>
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
            </>
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

      {!msg.deleted && msg.reactions.length > 0 && (
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

      {!msg.deleted && replyCount > 0 && (
        <button
          className="thread-chip"
          style={THREAD}
          title={`Jump to ${replyCount === 1 ? "reply" : "replies"}`}
          onClick={() => {
            if (firstReplyId) onJumpTo?.(firstReplyId)
          }}
        >
          <CornerDownRight size={11} /> {replyCount} {replyCount === 1 ? "reply" : "replies"}
        </button>
      )}

      <div className="foot">
        <span>{formatTime(msg.createdAt)}</span>
        {!msg.deleted && msg.editedAt && (
          <span className="edited-tag" style={EDITED}>
            edited
          </span>
        )}
        {!msg.deleted && msg.burn && (
          <span className="burn-tag">
            <Flame size={10} /> Read once
          </span>
        )}
        {!msg.deleted && ttl && (
          <span className="ttl">
            <Clock size={10} /> {ttl}
          </span>
        )}
        {msg.mine && !msg.deleted && <SendState failed={msg.failed} pending={msg.pending} seen={seen} />}
        {msg.mine && !msg.deleted && seenByNames && seenByNames.length > 0 && (
          <span className="seen-by" style={SEENBY} title={`Seen by ${seenByNames.join(", ")}`}>
            Seen by {seenByNames.length <= 2 ? seenByNames.join(", ") : `${seenByNames.length} people`}
          </span>
        )}
        {msg.mine && msg.failed && onRetry && (
          <button className="retry-btn" onClick={() => onRetry(msg.id)} aria-label="Retry sending">
            <RotateCw size={11} /> Retry
          </button>
        )}
        {!msg.deleted && (msg.keyChanged || msg.verified === "bad") && (
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
const DELETED = {
  display: "inline-flex",
  alignItems: "center",
  gap: "5px",
  fontStyle: "italic" as const,
  opacity: 0.6,
}
const EDITED = { opacity: 0.6, fontStyle: "italic" as const }
const SEENBY = { opacity: 0.75 }
const THREAD = {
  display: "inline-flex",
  alignItems: "center",
  gap: "4px",
  marginTop: "3px",
  padding: "2px 8px",
  fontSize: "11px",
  lineHeight: 1.4,
  borderRadius: "999px",
  border: "1px solid var(--border, rgba(255,255,255,0.14))",
  background: "transparent",
  color: "var(--text-dim, inherit)",
  cursor: "pointer",
} as const

export const MessageItem = memo(MessageItemInner)
