import { useEffect, useMemo, useRef, useState } from "react"
import {
  ArrowDown,
  Ban,
  Bell,
  BellOff,
  BookmarkPlus,
  CheckSquare,
  ChevronDown,
  ChevronUp,
  DoorOpen,
  Download,
  Eye,
  EyeOff,
  Flame,
  Ghost,
  Maximize2,
  Minimize2,
  Moon,
  MoreVertical,
  Pencil,
  QrCode,
  Search,
  Share2,
  ShieldCheck,
  Sun,
  Tag,
  Trash2,
  Type,
  Users,
  Volume2,
  VolumeX,
  X,
  Zap,
} from "lucide-react"
import type { RoomSession } from "../lib/session"
import type { Prefs } from "../lib/usePrefs"
import { useRoom } from "../lib/useRoom"
import type { DecryptedMessage, ReplyRef } from "../lib/messages"
import type { MediaManifestItem } from "../lib/media"
import { revokeAllObjectUrls } from "../lib/media"
import { formatCountdown } from "../lib/format"
import { vault } from "../lib/vault"
import { enableNotifications, notificationsEnabled, setNotificationsEnabled } from "../lib/notify"
import { subscribePush, unsubscribePush } from "../lib/push"
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
  const [notifOn, setNotifOn] = useState(() => notificationsEnabled())
  const [muted, setMuted] = useState(() => !!vault.get(session.invite.roomId)?.muted)
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [matchIdx, setMatchIdx] = useState(-1)

  const isOwner = room.isOwner
  const topic = room.topic

  const scrollRef = useRef<HTMLDivElement>(null)
  const nearBottom = useRef(true)
  const lastCount = useRef(0)
  const unreadLen = useRef(0)

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
  // tab is in the background. Muted rooms stay silent (badge still updates).
  useEffect(() => {
    const msgs = room.messages
    const added = msgs.length - unreadLen.current
    unreadLen.current = msgs.length
    if (added <= 0) return
    const incoming = msgs.slice(-added).filter((m) => m.kind !== "system" && !m.mine)
    if (incoming.length === 0) return
    if (document.visibilityState === "hidden") {
      setUnread((u) => u + incoming.length)
      if (prefs.sound && !muted) playChime()
    }
  }, [room.messages, prefs.sound, muted])

  useEffect(() => {
    document.title = unread > 0 ? `(${unread}) Vanish` : "Vanish"
  }, [unread])

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

  // Tell peers how far we've read so they get per-person read receipts. Fires
  // when new messages arrive (while visible) and when the tab regains focus.
  useEffect(() => {
    const markIfVisible = () => {
      if (document.visibilityState === "hidden") return
      const msgs = room.messages
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].kind !== "system") {
          room.markSeen(msgs[i].createdAt)
          break
        }
      }
    }
    markIfVisible()
    window.addEventListener("focus", markIfVisible)
    document.addEventListener("visibilitychange", markIfVisible)
    return () => {
      window.removeEventListener("focus", markIfVisible)
      document.removeEventListener("visibilitychange", markIfVisible)
    }
  }, [room.messages, room.markSeen])

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

  // Scroll to a quoted message and briefly highlight it (inline style only, so
  // no global CSS is required).
  function jumpToMessage(id: string) {
    const el = scrollRef.current?.querySelector(`[data-mid="${id}"]`) as HTMLElement | null
    if (!el) return
    el.scrollIntoView({ behavior: "smooth", block: "center" })
    const prev = el.style.backgroundColor
    el.style.transition = "background-color .25s ease"
    el.style.backgroundColor = "var(--accent-weak, rgba(124, 131, 253, 0.16))"
    window.setTimeout(() => {
      el.style.backgroundColor = prev
    }, 1100)
  }

  // Client-side search across the decrypted conversation. Everything stays on
  // this device — the server never sees the query (it can't search ciphertext).
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (q.length < 2) return [] as string[]
    return room.messages
      .filter((m) => {
        if (m.deleted || m.kind === "system") return false
        const text = (m.text ?? "").toLowerCase()
        const who = (m.username ?? "").toLowerCase()
        return text.includes(q) || who.includes(q)
      })
      .map((m) => m.id)
  }, [room.messages, query])

  function gotoMatch(dir: 1 | -1) {
    if (matches.length === 0) return
    const len = matches.length
    const base = matchIdx < 0 && dir === -1 ? 0 : matchIdx
    const next = ((base + dir) % len + len) % len
    setMatchIdx(next)
    jumpToMessage(matches[next])
  }

  function toggleSearch() {
    setSearchOpen((v) => !v)
    setQuery("")
    setMatchIdx(-1)
  }

  function toggleMute() {
    const next = !muted
    setMuted(next)
    vault.setMuted(session.invite.roomId, next)
    setPanel(null)
    toast(
      next
        ? "Room muted on this device — no sounds or pop-up alerts"
        : "Room unmuted",
    )
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
      m.text && !m.text.startsWith("⚠")
        ? m.text.slice(0, 90)
        : m.items && m.items.length > 0
          ? "📎 Attachment"
          : "Message"
    setReplyTo({ id: m.id, username: m.username, preview })
  }

  function editMessage(m: DecryptedMessage) {
    const next = window.prompt("Edit your message:", m.text ?? "")
    if (next === null) return
    const trimmed = next.trim()
    if (trimmed && trimmed !== m.text) {
      void room.editMessage(m.id, trimmed)
      toast("Message edited")
    }
  }

  function deleteMessage(m: DecryptedMessage) {
    if (window.confirm("Delete this message for everyone in the room?")) {
      void room.deleteMessage(m.id)
    }
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
    toast("Saved — you can rejoin this room after a refresh")
  }

  async function toggleNotifications() {
    if (notifOn) {
      setNotificationsEnabled(false)
      setNotifOn(false)
      if (prefs.sound) prefs.toggleSound()
      void unsubscribePush(session)
      toast("Notifications off")
      return
    }
    const result = await enableNotifications()
    if (result === "unsupported") {
      toast("This browser can’t show notifications")
      return
    }
    if (result === "blocked") {
      toast("Notifications are blocked — allow them in your browser’s site settings")
      return
    }
    setNotifOn(true)
    if (!prefs.sound) prefs.toggleSound()
    void subscribePush(session)
    toast("Notifications on — you’ll be alerted even when Vanish is closed")
  }

  function editTopic() {
    const next = window.prompt(
      "Set an encrypted room topic (everyone with the invite key can read it):",
      topic,
    )
    if (next === null) return
    void room.setTopic(next.trim())
    setPanel(null)
    toast(next.trim() ? "Topic updated" : "Topic cleared")
  }

  function exportTranscript() {
    const lines = room.messages
      .filter((m) => m.kind !== "system")
      .map((m) => {
        const when = new Date(m.createdAt).toISOString()
        const who = m.mine ? `${m.username || "anon"} (you)` : m.username || "anon"
        const body =
          m.text && !m.text.startsWith("⚠")
            ? m.text
            : m.items && m.items.length > 0
              ? `[${m.items.length} attachment(s)]`
              : ""
        return `[${when}] ${who}: ${body}`
      })
    const header =
      `Vanish transcript\nRoom: ${session.invite.roomId}\nExported: ${new Date().toISOString()}\n` +
      `${"=".repeat(48)}\n\n`
    const blob = new Blob([header + lines.join("\n") + "\n"], { type: "text/plain;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `vanish-${session.invite.roomId.slice(0, 8)}.txt`
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 2000)
    setPanel(null)
    toast("Transcript exported to this device")
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

  function changeNickname() {
    const name = window.prompt("Choose a new display name for this room:", session.username)
    if (name && name.trim()) {
      room.rename(name.trim())
      setPanel(null)
      toast("Nickname updated")
    }
  }

  const typingText = useMemo(() => {
    const names = room.typing.map((t) => t.username)
    if (names.length === 0) return ""
    if (names.length === 1) return `${names[0]} is typing…`
    if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`
    return "Several people are typing…"
  }, [room.typing])

  // Id of my most recent (non-deleted) message — the only one we annotate with
  // per-person read receipts, to avoid cluttering every bubble.
  const lastMineId = useMemo(() => {
    for (let i = room.messages.length - 1; i >= 0; i--) {
      const m = room.messages[i]
      if (m.mine && m.kind !== "system" && !m.deleted) return m.id
    }
    return null
  }, [room.messages])

  // Reply-thread indicators: how many messages reply to each message, and the
  // first reply's id for the jump-to-thread chip.
  const replyInfo = useMemo(() => {
    const counts = new Map<string, number>()
    const firstReply = new Map<string, string>()
    for (const m of room.messages) {
      if (m.replyTo) {
        counts.set(m.replyTo.id, (counts.get(m.replyTo.id) ?? 0) + 1)
        if (!firstReply.has(m.replyTo.id)) firstReply.set(m.replyTo.id, m.id)
      }
    }
    return { counts, firstReply }
  }, [room.messages])

  // Known participants for the member sheet: anyone we have a name for, plus
  // ourselves and anyone currently banned. Participants are anonymous, so this
  // is necessarily limited to people who have spoken (or been banned).
  const participants = useMemo(() => {
    const banned = new Set(room.room?.banned ?? [])
    const map = new Map<string, { pid: string; name: string; banned: boolean }>()
    map.set(session.participantId, {
      pid: session.participantId,
      name: session.username,
      banned: false,
    })
    for (const [pid, name] of Object.entries(room.names)) {
      map.set(pid, { pid, name: name || "anon", banned: banned.has(pid) })
    }
    for (const pid of banned) {
      if (!map.has(pid)) map.set(pid, { pid, name: "anon", banned: true })
    }
    return Array.from(map.values())
  }, [room.names, room.room, session.participantId, session.username])

  if (room.bannedSelf) {
    return (
      <div className="center-shell">
        <div className="card join-card" style={CENTER}>
          <Ban size={34} color="var(--accent)" />
          <h2 style={MT}>Removed from room</h2>
          <p className="hint" style={MB}>
            The room owner has removed you from this room. Your access has ended.
          </p>
          <button className="btn btn-primary btn-block" onClick={onLeave}>
            Back to home
          </button>
        </div>
      </div>
    )
  }

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
                <span className="hide-sm">{topic || "Vanish room"}</span>
              </button>
              <span className="s">
                <span className={`dot ${room.connState}`} />
                {labelFor(room.connState)}
                <MemberDots count={room.participantCount} onClick={() => setPanel("members")} />
                <RoomTimer destroyAt={room.room?.destroyAt ?? null} />
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
                icon={<Search size={18} />}
                label="Search messages"
                onClick={toggleSearch}
                active={searchOpen}
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
                icon={notifOn ? <Bell size={18} /> : <BellOff size={18} />}
                label={notifOn ? "Notifications on" : "Enable notifications"}
                onClick={toggleNotifications}
                active={notifOn}
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

      {searchOpen && !selecting && (
        <div className="search-bar" style={SEARCH_BAR}>
          <Search size={15} style={SEARCH_ICON} />
          <input
            className="input"
            style={SEARCH_INPUT}
            placeholder="Search this conversation (stays on this device)…"
            value={query}
            autoFocus
            onChange={(e) => {
              setQuery(e.target.value)
              setMatchIdx(-1)
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault()
                gotoMatch(e.shiftKey ? -1 : 1)
              } else if (e.key === "Escape") {
                toggleSearch()
              }
            }}
            aria-label="Search messages"
          />
          {query.trim().length >= 2 && (
            <span style={SEARCH_COUNT}>
              {matchIdx >= 0 ? matchIdx + 1 : 0}/{matches.length}
            </span>
          )}
          <IconButton
            icon={<ChevronUp size={16} />}
            label="Previous match"
            onClick={() => gotoMatch(-1)}
          />
          <IconButton
            icon={<ChevronDown size={16} />}
            label="Next match"
            onClick={() => gotoMatch(1)}
          />
          <IconButton icon={<X size={16} />} label="Close search" onClick={toggleSearch} />
        </div>
      )}

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
                This room is empty and encrypted end-to-end. Say hello — messages auto-delete on the
                schedule you chose.
              </p>
            </div>
          )}
          {room.messages.map((m, i) => {
            const prev = room.messages[i - 1]
            const showWho = !prev || prev.participantId !== m.participantId || prev.kind === "system"
            const seen = room.participantCount > 1 && room.othersSeenUpTo >= m.createdAt
            const seenByNames =
              m.id === lastMineId
                ? Object.entries(room.seenBy)
                    .filter(([pid, ts]) => pid !== session.participantId && ts >= m.createdAt)
                    .map(([pid]) => room.names[pid] || "someone")
                : undefined
            return (
              <MessageItem
                key={m.id}
                session={session}
                msg={m}
                showWho={showWho}
                selecting={selecting}
                selected={selected.has(m.id)}
                seen={seen}
                seenByNames={seenByNames}
                replyCount={replyInfo.counts.get(m.id) ?? 0}
                firstReplyId={replyInfo.firstReply.get(m.id)}
                onToggleSelect={toggleSelect}
                onReact={room.toggleReaction}
                onReply={startReply}
                onEdit={editMessage}
                onDelete={deleteMessage}
                onOpenMedia={setViewer}
                onRetry={room.retrySend}
                onJumpTo={jumpToMessage}
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
        <Sheet title="Who’s here" icon={<Users size={18} />} onClose={() => setPanel(null)}>
          <div className="stack">
            <div className="members-count">
              <span className="big">{room.participantCount}</span>
              <span>
                {room.participantCount === 1
                  ? "person here right now — just you"
                  : "people here right now"}
              </span>
            </div>
            {topic && (
              <p className="hint">
                <Tag size={13} /> Topic: <strong>{topic}</strong>
              </p>
            )}
            <div className="member-list">
              {participants.map((p) => (
                <div key={p.pid} className="member-row" style={MEMBER_ROW}>
                  <span style={p.banned ? MEMBER_BANNED : undefined}>
                    {p.name}
                    {p.pid === session.participantId ? " (you)" : ""}
                    {p.banned ? " — banned" : ""}
                  </span>
                  {isOwner && p.pid !== session.participantId && (
                    <button
                      className={`btn ${p.banned ? "" : "btn-danger"}`}
                      onClick={() => (p.banned ? room.unbanMember(p.pid) : room.banMember(p.pid))}
                    >
                      {p.banned ? (
                        "Unban"
                      ) : (
                        <>
                          <Ban size={14} /> Ban
                        </>
                      )}
                    </button>
                  )}
                </div>
              ))}
            </div>
            <p className="hint">
              Presence counts anyone active in roughly the last 45 seconds. Vanish is anonymous, so
              the server can’t verify identities — treat this as an approximate count, and use the
              safety number (the shield icon) to confirm exactly who you’re talking to.
              {isOwner ? " As the room owner, you can ban anyone who has spoken here." : ""}
            </p>
          </div>
        </Sheet>
      )}
      {panel === "actions" && (
        <Sheet title="Room actions" icon={<MoreVertical size={18} />} onClose={() => setPanel(null)}>
          <div className="stack">
            <button className="btn btn-block" onClick={changeNickname}>
              <Pencil size={16} /> Change your nickname
            </button>
            {isOwner && (
              <button className="btn btn-block" onClick={editTopic}>
                <Tag size={16} /> {topic ? "Change room topic" : "Set room topic"}
              </button>
            )}
            <button
              className="btn btn-block"
              onClick={() => {
                room.toggleDecoy()
                toast(
                  room.decoyEnabled
                    ? "Decoy messages off"
                    : "Decoy messages on — sending fake encrypted messages to hide when you’re really talking",
                )
              }}
            >
              <Ghost size={16} /> Decoy messages: {room.decoyEnabled ? "on" : "off"}
            </button>
            <p className="hint" style={DECOY_HINT}>
              Sends harmless fake messages in the background so an outside observer can’t tell when
              you’re actually chatting. Recipients silently ignore them — only the timing pattern of
              your traffic is masked.
            </p>
            <button className="btn btn-block" onClick={toggleMute}>
              {muted ? <Volume2 size={16} /> : <VolumeX size={16} />}{" "}
              {muted ? "Unmute this room" : "Mute this room (this device)"}
            </button>
            <button className="btn btn-block" onClick={exportTranscript}>
              <Download size={16} /> Export transcript (this device)
            </button>
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
              <Zap size={16} /> Panic — wipe view & leave
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

function MemberDots({ count, onClick }: { count: number; onClick?: () => void }) {
  const shown = Math.min(count, 4)
  return (
    <button
      type="button"
      className="members members-btn"
      title={`${count} here — tap for details`}
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

// Ticks once a second to show how long until the whole room self-destructs.
function RoomTimer({ destroyAt }: { destroyAt: number | null }) {
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!destroyAt) return
    const t = setInterval(() => setTick((n) => (n + 1) % 3600), 1000)
    return () => clearInterval(t)
  }, [destroyAt])
  if (!destroyAt) return null
  const left = formatCountdown(destroyAt)
  if (!left) return null
  return (
    <span className="room-timer" title="This room self-destructs automatically">
      <Flame size={11} /> {left}
    </span>
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
      return "Connecting…"
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
const DECOY_HINT = { marginTop: "-4px" }
const MEMBER_ROW = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "10px",
  padding: "8px 0",
}
const MEMBER_BANNED = { opacity: 0.6, textDecoration: "line-through" as const }
const SEARCH_BAR = {
  display: "flex",
  alignItems: "center",
  gap: "6px",
  padding: "6px 10px",
  borderBottom: "1px solid var(--border, rgba(255,255,255,0.08))",
} as const
const SEARCH_ICON = { flex: "none", opacity: 0.7 } as const
const SEARCH_INPUT = { flex: 1, minWidth: 0, padding: "6px 10px" } as const
const SEARCH_COUNT = {
  fontSize: "12px",
  color: "var(--text-faint)",
  minWidth: "34px",
  textAlign: "center",
} as const
