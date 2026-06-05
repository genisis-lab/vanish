import { useEffect, useMemo, useRef, useState } from "react"
import {
  ArrowDown,
  CheckSquare,
  Fingerprint,
  Flame,
  Link2,
  LogOut,
  Maximize2,
  Minimize2,
  Moon,
  MoreVertical,
  QrCode,
  Sun,
  Trash2,
  Users,
  X,
} from "lucide-react"
import type { RoomSession } from "../lib/session"
import type { Prefs } from "../lib/usePrefs"
import { useRoom } from "../lib/useRoom"
import type { MediaManifestItem } from "../lib/media"
import { revokeAllObjectUrls } from "../lib/media"
import { IconButton, Sheet, useToast } from "./ui"
import { MessageItem } from "./MessageItem"
import { Composer } from "./Composer"
import { InvitePanel } from "./InvitePanel"
import { SafetyPanel } from "./SafetyPanel"
import { MediaViewer } from "./MediaViewer"

type Panel = "invite" | "invite-qr" | "safety" | "actions" | null

export function ChatRoom({
  session,
  prefs,
  onLeave,
}: {
  session: RoomSession
  prefs: Prefs
  onLeave: () => void
}) {
  const toast = useToast()
  const room = useRoom(session)
  const [panel, setPanel] = useState<Panel>(null)
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [viewer, setViewer] = useState<MediaManifestItem | null>(null)
  const [showJump, setShowJump] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const scrollRef = useRef<HTMLDivElement>(null)
  const nearBottom = useRef(true)
  const lastCount = useRef(0)

  useEffect(() => () => revokeAllObjectUrls(), [])

  useEffect(() => {
    if (room.error) toast(room.error)
  }, [room.error, toast])

  useEffect(() => {
    if (room.deleted) {
      toast("This room was deleted")
    }
  }, [room.deleted, toast])

  // Auto-scroll only when the user is near the bottom; otherwise surface a pill.
  useEffect(() => {
    const grew = room.messages.length > lastCount.current
    lastCount.current = room.messages.length
    if (!grew) return
    if (nearBottom.current) {
      requestAnimationFrame(() =>
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }),
      )
    } else {
      setShowJump(true)
    }
  }, [room.messages.length])

  function onScroll() {
    const el = scrollRef.current
    if (!el) return
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight
    nearBottom.current = gap < 120
    if (nearBottom.current) setShowJump(false)
  }

  function jumpToBottom() {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" })
    setShowJump(false)
  }

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function cancelSelect() {
    setSelecting(false)
    setSelected(new Set())
  }

  async function pruneSelected() {
    await room.prune(Array.from(selected))
    cancelSelect()
  }

  async function doDelete() {
    await room.deleteRoom()
    setConfirmDelete(false)
    setPanel(null)
    onLeave()
  }

  const typingText = useMemo(() => {
    const names = room.typing.map((t) => t.username)
    if (names.length === 0) return ""
    if (names.length === 1) return `${names[0]} is typing…`
    if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`
    return "Several people are typing…"
  }, [room.typing])

  if (room.deleted) {
    return (
      <div className="center-shell">
        <div className="card join-card" style={CENTER}>
          <Flame size={34} color="var(--accent)" />
          <h2 style={MT}>Room deleted</h2>
          <p className="hint" style={MB}>
            All encrypted messages and media for this room have been removed from the server.
          </p>
          <button className="btn btn-primary btn-block" onClick={onLeave}>
            Back to home
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className={`chat ${prefs.compact ? "compact" : ""}`}>
      <div className="topbar">
        {selecting ? (
          <div className="select-bar" style={GROW}>
            <IconButton icon={<X size={18} />} label="Cancel selection" onClick={cancelSelect} />
            <span className="count">{selected.size} selected</span>
            <button className="btn btn-danger" disabled={selected.size === 0} onClick={pruneSelected}>
              <Trash2 size={15} /> Prune
            </button>
          </div>
        ) : (
          <>
            <div className="room-id">
              <span className="t">
                <Flame size={16} color="var(--accent)" />
                <span className="hide-sm">Vanish room</span>
              </span>
              <span className="s">
                <span className={`dot ${room.connState}`} />
                {labelFor(room.connState)} · <Users size={11} /> {room.participantCount}
              </span>
            </div>
            <div className="topbar-actions">
              <IconButton icon={<Link2 size={19} />} label="Invite" onClick={() => setPanel("invite")} />
              <IconButton
                icon={<Fingerprint size={19} />}
                label="Verify encryption"
                onClick={() => setPanel("safety")}
              />
              <IconButton
                icon={<QrCode size={19} />}
                label="Show invite QR"
                onClick={() => setPanel("invite-qr")}
                className="hide-sm"
              />
              <IconButton
                icon={prefs.compact ? <Maximize2 size={18} /> : <Minimize2 size={18} />}
                label={prefs.compact ? "Exit compact mode" : "Compact mode"}
                onClick={prefs.toggleCompact}
                active={prefs.compact}
              />
              <IconButton
                icon={prefs.theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
                label="Toggle theme"
                onClick={prefs.toggleTheme}
              />
              <IconButton
                icon={<MoreVertical size={19} />}
                label="Room actions"
                onClick={() => setPanel("actions")}
              />
              <IconButton icon={<LogOut size={18} />} label="Leave room" onClick={onLeave} />
            </div>
          </>
        )}
      </div>

      <div className="chat-body">
        <div className="messages" ref={scrollRef} onScroll={onScroll}>
          {room.messages.length === 0 && (
            <div className="center-spinner" style={EMPTY}>
              <Flame size={26} color="var(--accent)" />
              <p className="hint" style={EMPTYTEXT}>
                This room is empty and encrypted end-to-end. Say hello — messages auto-delete on the
                schedule you chose.
              </p>
            </div>
          )}
          {room.messages.map((m, i) => {
            const prev = room.messages[i - 1]
            const showWho = !prev || prev.participantId !== m.participantId || prev.kind === "system"
            const seen = room.participantCount > 1 && room.othersSeenUpTo >= m.createdAt
            return (
              <MessageItem
                key={m.id}
                session={session}
                msg={m}
                showWho={showWho}
                selecting={selecting}
                selected={selected.has(m.id)}
                seen={seen}
                onToggleSelect={toggleSelect}
                onReact={room.toggleReaction}
                onOpenMedia={setViewer}
              />
            )
          })}
        </div>

        {showJump && (
          <button className="jump-pill" onClick={jumpToBottom}>
            <ArrowDown size={15} /> New messages
          </button>
        )}
      </div>

      <div className="typing">{typingText}</div>

      <Composer
        uploads={room.uploads}
        onSend={room.sendText}
        onSendMedia={room.sendMedia}
        onTyping={room.notifyTyping}
      />

      {panel === "invite" && (
        <InvitePanel session={session} prefs={prefs} onClose={() => setPanel(null)} />
      )}
      {panel === "invite-qr" && (
        <InvitePanel session={session} prefs={prefs} initialQr onClose={() => setPanel(null)} />
      )}
      {panel === "safety" && (
        <SafetyPanel session={session} prefs={prefs} onClose={() => setPanel(null)} />
      )}
      {panel === "actions" && (
        <Sheet title="Room actions" icon={<MoreVertical size={18} />} onClose={() => setPanel(null)}>
          <div className="stack">
            <button
              className="btn btn-block"
              onClick={() => {
                setSelecting(true)
                setPanel(null)
              }}
            >
              <CheckSquare size={16} /> Select messages to prune
            </button>
            <button
              className="btn btn-block"
              onClick={() => {
                void room.pruneAll()
                setPanel(null)
                toast("Cleared all messages")
              }}
            >
              <Trash2 size={16} /> Clear all visible messages
            </button>
            {confirmDelete ? (
              <button className="btn btn-danger btn-block" onClick={doDelete}>
                <Trash2 size={16} /> Confirm — delete room & all data
              </button>
            ) : (
              <button className="btn btn-danger btn-block" onClick={() => setConfirmDelete(true)}>
                <Trash2 size={16} /> Delete room & encrypted data
              </button>
            )}
            <p className="hint">
              Deleting removes every encrypted message and media object from the server for all
              participants. This cannot be undone.
            </p>
          </div>
        </Sheet>
      )}

      {viewer && <MediaViewer session={session} item={viewer} onClose={() => setViewer(null)} />}
    </div>
  )
}

function labelFor(state: string): string {
  switch (state) {
    case "live":
      return "Live"
    case "polling":
      return "Reconnecting"
    case "connecting":
      return "Connecting"
    default:
      return "Offline"
  }
}

const CENTER = { textAlign: "center" as const }
const MT = { marginTop: "12px" }
const MB = { marginBottom: "16px" }
const GROW = { flex: 1, border: "none", padding: 0, background: "transparent" }
const EMPTY = { flex: "none" as const, padding: "40px 20px" }
const EMPTYTEXT = { maxWidth: "320px", textAlign: "center" as const }
