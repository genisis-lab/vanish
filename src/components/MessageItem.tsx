import { memo, useState } from "react"
import { Check, CheckCheck, Clock, Flame, Reply, SmilePlus } from "lucide-react"
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
}: Props) {
  const [picker, setPicker] = useState(false)

  if (msg.kind === "system") {
    return <div className="sys-line">{msg.text}</div>
  }

  const hue = hueFromString(msg.username)
  const whoStyle = { color: `hsl(${hue} 55% 60%)` }
  const ttl = formatCountdown(msg.expiresAt)

  function click() {
    if (selecting) onToggleSelect(msg.id)
  }

  const tools = !selecting && (
    <div className="msg-tools">
      <button
        className="icon-btn mini"
        aria-label="Reply"
        onClick={() => onReply(msg)}
      >
        <Reply size={15} />
      </button>
      <button
        className="icon-btn mini"
        aria-label="Add reaction"
        onClick={() => setPicker((v) => !v)}
      >
        <SmilePlus size={15} />
      </button>
    </div>
  )

  return (
    <div className={`msg ${msg.mine ? "mine" : ""} ${selected ? "selected" : ""}`}>
      {showWho && !msg.mine && (
        <div className="who" style={whoStyle}>
          {msg.username}
        </div>
      )}

      <div style={ROW}>
        {!msg.mine && tools}

        <div className="bubble" onClick={click} role={selecting ? "button" : undefined}>
          {msg.replyTo && (
            <div className="quote">
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

        {msg.mine && tools}
      </div>

      {picker && (
        <div className="emoji-pop">
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

export const MessageItem = memo(MessageItemInner)
