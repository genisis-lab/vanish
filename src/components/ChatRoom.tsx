import { useEffect, useMemo, useRef, useState } from "react"
import {
  ArrowDown,
  Bell,
  BellOff,
  BookmarkPlus,
  CheckSquare,
  DoorOpen,
  Eye,
  EyeOff,
  Flame,
  Maximize2,
  Minimize2,
  Moon,
  MoreVertical,
  QrCode,
  Share2,
  ShieldCheck,
  Sun,
  Trash2,
  Type,
  Users,
  X,
  Zap,
} from "lucide-react"
import type { RoomSession } from "../lib/session"
import type { Prefs } from "../lib/usePrefs"
import { useRoom } from "../lib/useRoom"
import type { DecryptedMessage, ReplyRef } from "../lib/messages"
import type { MediaManifestItem } from "../lib/media"
import { revokeAllObjectUrls } from "../lib/media"
import { vault } from "../lib/vault"
import { IconButton, Sheet, useToast } from "./ui"
import { MessageItem } from "./MessageItem"
import { Composer } from "./Composer"
import { InvitePanel } from "./InvitePanel"
import { SafetyPanel } from "./SafetyPanel"
import { MediaViewer } from "./MediaViewer"

type Panel = "invite" | "invite-qr" | "safety" | "actions" | "members" | null

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
  const [replyTo, setReplyTo] = useState<ReplyRef | null>(null)
  const [privacy, setPrivacy] = useState(true)
  const [hidden, setHidden] = useState(false)
  const [unread, setUnread] = useState(0)
  const [savePrompt, setSavePrompt] = useState(() => !vault.get(session.invite.roomId))

  const scrollRef = useRef<HTMLDivElement>(null)
  const nearBottom = useRef(true)
  const lastCount = useRef(0)
  const unreadLen = useRef(0)
  const nudgedRef = useRef(false)

  useEffect(() => () => revokeAllObjectUrls(), [])

  // Privacy veil: blur the conversation whenever the tab loses focus, so a
  // glance over your shoulder (or an app switcher preview) reveals nothing.
  useEffect(() => {
    const onVis = () => {
      const away = document.visibilityState === "hidden"
      setHidden(away)
      if (!away) setUnread(0)
    }
    const onBlur = () => setHidden(true)
    const onFocus = () => {
      setHidden(false)
      setUnread(0)
    }
    document.addEventListener("visibilitychange", onVis)
    window.addEventListener("blur", onBlur)
    window.addEventListener("focus", onFocus)
    return () => {
      document.removeEventListener("visibilitychange", onVis)
      window.removeEventListener("blur", onBlur)
      window.removeEventListener("focus", onFocus)
    }
  }, [])

  // Unread title badge + notification sound for messages that arrive while the
  // tab is in the background.
  useEffect(() => {
    const msgs = room.messages
    const added = msgs.length - unreadLen.current
    unreadLen.current = msgs.length
    if (added <= 0) return
    const incoming = msgs.slice(-added).filter((m) => m.kind !== "system" && !m.mine)
    if (incoming.length === 0) return
    if (document.visibilityState === "hidden") {
      setUnread((u) => u + incoming.length)
      if (prefs.sound) playChime()
    }
  }, [room.messages, prefs.sound])

  useEffect(() => {
    document.title = unread > 0 ? `(${unread}) Vanish` : "Vanish"
  }, [unread])

  // Nudge the user to verify their safety number the first time a second
  // participant appears (and only if they haven't already verified it).
  useEffect(() => {
    if (room.participantCount >= 2 && !nudgedRef.current) {
      nudgedRef.current = true
      if (!vault.get(session.invite.roomId)?.verifiedSafetyNumber) {
        toast("Someone else is here \u2014 tap the shield to verify your safety number")
      }
    }
  }, [room.participantCount, session.invite.roomId, toast])

  // When the visible viewport shrinks (mobile keyboard opening), keep the
  // latest messages in view if the user was already at the bottom.
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const onResize = () => {
      if (nearBottom.current) {
        requestAnimationFrame(() =>
          scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }),
        )
      }
    }
    vv.addEventListener("resize", onResize)
    return () => vv.removeEventListener("resize", onResize)
  }, [])

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

  function startReply(m: DecryptedMessage) {
    const preview =
      m.text && !m.text.startsWith("\u26a0")
        ? m.text.slice(0, 90)
        : m.items && m.items.length > 0
          ? "\u{1F4CE} Attachment"
          : "Message"
    setReplyTo({ id: m.id, username: m.username, preview })
  }

  function saveRoom() {
    if (vault.isLocked()) {
      toast("Unlock your device vault first to save this room")
      setSavePrompt(false)
      return
    }
    vault.setRememberEnabled(true)
    vault.save({
      roomId: session.invite.roomId,
      inviteKey: session.invite.inviteKey,
      username: session.username,
      participantId: session.participantId,
      lastUsed: Date.now(),
    })
    setSavePrompt(false)
    toast("Saved \u2014 you can rejoin this room after a refresh")
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

  function panic() {
    void room.pruneAll()
    setPanel(null)
    onLeave()
  }

  const typingText = useMemo(() => {
    const names = room.typing.map((t) => t.username)
    if (names.length === 0) return ""
    if (names.length === 1) return `${names[0]} is typing\u2026`
    if (names.length === 2) return `${names[0]} and ${names[1]} are typing\u2026`
    return "Several people are typing\u2026"
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

  const veiled = privacy && hidden

  return (
    <div className={`chat ${prefs.compact ? "compact" : ""} fs-${prefs.fontScale}`}>
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
              <button type="button" className="t brand-home" onClick={onLeave} title="Back to home">
                <Flame size={16} color="var(--accent)" />
                <span className="hide-sm">Vanish room</span>
              </button>
              <span className="s">
                <span className={`dot ${room.connState}`} />
                {labelFor(room.connState)}
                <MemberDots count={room.participantCount} onClick={() => setPanel("members")} />
              </span>
            </div>
            <div className="topbar-actions">
              <IconButton icon={<Share2 size={19} />} label="Invite" onClick={() => setPanel("invite")} />
              <IconButton
                icon={<ShieldCheck size={19} />}
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
                icon={privacy ? <Eye size={18} /> : <EyeOff size={18} />}
                label={privacy ? "Privacy blur on" : "Privacy blur off"}
                onClick={() => setPrivacy((v) => !v)}
                active={privacy}
                className="hide-sm"
              />
              <IconButton
                icon={prefs.sound ? <Bell size={18} /> : <BellOff size={18} />}
                label={prefs.sound ? "Mute notifications" : "Enable notifications"}
                onClick={prefs.toggleSound}
                active={prefs.sound}
                className="hide-sm"
              />
              <IconButton
                icon={prefs.compact ? <Maximize2 size={18} /> : <Minimize2 size={18} />}
                label={prefs.compact ? "Exit compact mode" : "Compact mode"}
                onClick={prefs.toggleCompact}
                active={prefs.compact}
                className="hide-sm"
              />
              <IconButton
                icon={<Type size={18} />}
                label={`Text size: ${prefs.fontScale.toUpperCase()}`}
                onClick={prefs.cycleFontScale}
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
              <IconButton icon={<DoorOpen size={18} />} label="Leave room" onClick={onLeave} />
            </div>
          </>
        )}
      </div>

      {savePrompt && !selecting && (
        <div className="save-banner">
          <BookmarkPlus size={16} />
          <span>Remember this room on this device so you can rejoin after a refresh?</span>
          <div className="save-banner-actions">
            <button className="btn btn-primary" onClick={saveRoom}>
              Save
            </button>
            <button className="btn btn-ghost" onClick={() => setSavePrompt(false)}>
              Not now
            </button>
          </div>
        </div>
      )}

      <div className={`chat-body ${veiled ? "veiled" : ""}`}>
        <div className="messages" ref={scrollRef} onScroll={onScroll}>
          {room.messages.length === 0 && (
            <div className="center-spinner" style={EMPTY}>
              <Flame size={26} color="var(--accent)" />
              <p className="hint" style={EMPTYTEXT}>
                This room is empty and encrypted end-to-end. Say hello \u2014 messages auto-delete on the
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
                onReply={startReply}
                onOpenMedia={setViewer}
              />
            )
          })}
        </div>

        {veiled && (
          <div className="privacy-veil" aria-hidden="true">
            <EyeOff size={30} />
            <span>Conversation hidden</span>
          </div>
        )}

        {showJump && (
          <button className="jump-pill" onClick={jumpToBottom}>
            <ArrowDown size={15} /> {unread > 0 ? `${unread} new` : "New messages"}
          </button>
        )}
      </div>

      <div className="typing">
        {typingText && (
          <span className="typing-live">
            <span className="typing-dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            {typingText}
          </span>
        )}
      </div>

      <Composer
        uploads={room.uploads}
        roomId={session.invite.roomId}
        replyTo={replyTo}
        onCancelReply={() => setReplyTo(null)}
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
      {panel === "members" && (
        <Sheet title="Who\u2019s here" icon={<Users size={18} />} onClose={() => setPanel(null)}>
          <div className="stack">
            <div className="members-count">
              <span className="big">{room.participantCount}</span>
              <span>
                {room.participantCount === 1
                  ? "person here right now \u2014 just you"
                  : "people here right now"}
              </span>
            </div>
            <p className="hint">
              Presence counts anyone active in roughly the last 45 seconds. Vanish is anonymous, so
              the server can\u2019t verify identities \u2014 treat this as an approximate count, and use the
              safety number (the shield icon) to confirm exactly who you\u2019re talking to.
            </p>
          </div>
        </Sheet>
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
            <button className="btn btn-danger btn-block" onClick={panic}>
              <Zap size={16} /> Panic \u2014 wipe view & leave
            </button>
            {confirmDelete ? (
              <button className="btn btn-danger btn-block" onClick={doDelete}>
                <Trash2 size={16} /> Confirm \u2014 delete room & all data
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

function MemberDots({ count, onClick }: { count: number; onClick?: () => void }) {
  const shown = Math.min(count, 4)
  return (
    <button
      type="button"
      className="members members-btn"
      title={`${count} here \u2014 tap for details`}
      onClick={onClick}
    >
      <span className="member-dots" aria-hidden="true">
        {Array.from({ length: shown }).map((_, i) => (
          <i key={i} />
        ))}
      </span>
      <Users size={11} /> {count}
    </button>
  )
}

function playChime() {
  try {
    const Ctx =
      window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    const ctx = new Ctx()
    const o = ctx.createOscillator()
    const g = ctx.createGain()
    o.connect(g)
    g.connect(ctx.destination)
    o.type = "sine"
    o.frequency.value = 660
    g.gain.setValueAtTime(0.0001, ctx.currentTime)
    g.gain.exponentialRampToValueAtTime(0.14, ctx.currentTime + 0.01)
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.25)
    o.start()
    o.stop(ctx.currentTime + 0.26)
    setTimeout(() => void ctx.close(), 400)
  } catch {
    /* audio not available */
  }
}

function labelFor(state: string): string {
  switch (state) {
    case "live":
      return "Live"
    case "polling":
      return "Connected"
    case "connecting":
      return "Connecting\u2026"
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
