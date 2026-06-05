import { useMemo, useState } from "react"
import {
  ArrowRight,
  Clock,
  Flame,
  KeyRound,
  Lock,
  LogIn,
  Moon,
  Play,
  Plus,
  ServerOff,
  Shield,
  Sun,
  Trash2,
} from "lucide-react"
import type { InviteExpiryOption } from "@shared/types"
import { TTL_PRESETS, ROOM_LIFETIME_PRESETS, DEFAULT_MESSAGE_TTL_MS } from "@shared/constants"
import type { Prefs } from "../lib/usePrefs"
import type { RoomSession } from "../lib/session"
import { createRoom } from "../lib/createRoom"
import { vault, type RememberedRoom } from "../lib/vault"
import { formatRelative, hueFromString, initials } from "../lib/format"
import { IconButton, useToast } from "./ui"

interface HomeProps {
  prefs: Prefs
  onCreated: (s: RoomSession) => void
  onJoinKey: (rawKey: string) => boolean
  onResume: (roomId: string) => void
}

const EXPIRY_OPTIONS: { id: InviteExpiryOption; label: string }[] = [
  { id: "never", label: "Never" },
  { id: "24h", label: "24 hours" },
  { id: "7d", label: "7 days" },
]

export function Home({ prefs, onCreated, onJoinKey, onResume }: HomeProps) {
  const toast = useToast()
  const [tab, setTab] = useState<"create" | "join">("create")
  const [username, setUsername] = useState("")
  const [expiry, setExpiry] = useState<InviteExpiryOption>("never")
  const [ttlMs, setTtlMs] = useState<number>(DEFAULT_MESSAGE_TTL_MS)
  const [roomLifetimeMs, setRoomLifetimeMs] = useState<number>(0)
  const [burn, setBurn] = useState(false)
  const [joinKey, setJoinKey] = useState("")
  const [busy, setBusy] = useState(false)
  const [remember, setRemember] = useState(vault.isRememberEnabled())
  const rooms = useMemo<RememberedRoom[]>(() => vault.list(), [])

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    try {
      vault.setRememberEnabled(remember)
      const session = await createRoom({
        username,
        inviteExpiry: expiry,
        ttlMs,
        burnAfterRead: burn,
        roomLifetimeMs,
      })
      vault.save({
        roomId: session.invite.roomId,
        inviteKey: session.invite.inviteKey,
        username: session.username,
        participantId: session.participantId,
        lastUsed: Date.now(),
      })
      onCreated(session)
    } catch {
      toast("Could not create room. Check your connection.")
      setBusy(false)
    }
  }

  function handleJoin(e: React.FormEvent) {
    e.preventDefault()
    if (!onJoinKey(joinKey)) toast("That doesn't look like a valid invite key.")
  }

  const setRememberPersist = (on: boolean) => {
    setRemember(on)
    vault.setRememberEnabled(on)
  }

  return (
    <div className="shell">
      <div className="brandbar">
        <div className="brand">
          <span className="spark">
            <Flame size={19} />
          </span>
          Vanish
        </div>
        <IconButton
          icon={prefs.theme === "dark" ? <Sun size={19} /> : <Moon size={19} />}
          label={prefs.theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          onClick={prefs.toggleTheme}
        />
      </div>

      <div className="hero">
        <h1>
          Anonymous chat that <span className="grad">vanishes without a trace</span>
        </h1>
        <p>
          Spin up an end-to-end encrypted room, share one link, and talk freely. No accounts, no
          profiles — your keys never leave your browser.
        </p>
      </div>

      <div className="grid">
        <div className="card">
          <div className="seg" style={SEG_STYLE} role="tablist">
            <button
              className={tab === "create" ? "active" : ""}
              onClick={() => setTab("create")}
              role="tab"
              aria-selected={tab === "create"}
            >
              Create room
            </button>
            <button
              className={tab === "join" ? "active" : ""}
              onClick={() => setTab("join")}
              role="tab"
              aria-selected={tab === "join"}
            >
              Join with key
            </button>
          </div>

          {tab === "create" ? (
            <form onSubmit={handleCreate}>
              <div className="field">
                <label className="label" htmlFor="u1">
                  Display name
                </label>
                <input
                  id="u1"
                  className="input"
                  placeholder="e.g. midnight-fox"
                  value={username}
                  maxLength={32}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="off"
                />
              </div>

              <div className="field">
                <span className="label">Invite expires</span>
                <div className="seg">
                  {EXPIRY_OPTIONS.map((o) => (
                    <button
                      type="button"
                      key={o.id}
                      className={expiry === o.id ? "active" : ""}
                      onClick={() => setExpiry(o.id)}
                    >
                      {o.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="field">
                <label className="label" htmlFor="ttl">
                  Auto-delete messages after
                </label>
                <select
                  id="ttl"
                  className="input"
                  value={ttlMs}
                  onChange={(e) => setTtlMs(Number(e.target.value))}
                >
                  {TTL_PRESETS.map((p) => (
                    <option key={p.ms} value={p.ms}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="field">
                <label className="label" htmlFor="rlife">
                  Room self-destructs
                </label>
                <select
                  id="rlife"
                  className="input"
                  value={roomLifetimeMs}
                  onChange={(e) => setRoomLifetimeMs(Number(e.target.value))}
                >
                  {ROOM_LIFETIME_PRESETS.map((p) => (
                    <option key={p.ms} value={p.ms}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </div>

              <label className="upload-item" style={CHECK_ROW}>
                <input type="checkbox" checked={burn} onChange={(e) => setBurn(e.target.checked)} />
                <span>
                  <strong style={STRONG}>Burn after read</strong> — remove each message once another
                  participant has seen it.
                </span>
              </label>

              <label className="upload-item" style={CHECK_ROW}>
                <input
                  type="checkbox"
                  checked={remember}
                  onChange={(e) => setRememberPersist(e.target.checked)}
                />
                <span>Remember this room on this device so I can rejoin after refresh.</span>
              </label>

              <button className="btn btn-primary btn-block" disabled={busy} style={MT}>
                {busy ? <span className="spinner" /> : <Plus size={17} />}
                {busy ? "Creating…" : "Create encrypted room"}
              </button>
            </form>
          ) : (
            <form onSubmit={handleJoin}>
              <div className="field">
                <label className="label" htmlFor="jk">
                  Invite key or link
                </label>
                <textarea
                  id="jk"
                  className="textarea"
                  rows={3}
                  placeholder="anonchat:v1:…  or  https://…/#invite=…"
                  value={joinKey}
                  onChange={(e) => setJoinKey(e.target.value)}
                />
              </div>
              <p className="hint" style={MB}>
                The key contains the secret used to derive your encryption keys. Anyone with it can
                read the room — share it carefully.
              </p>
              <button className="btn btn-primary btn-block" disabled={!joinKey.trim()}>
                <LogIn size={17} /> Continue
              </button>
            </form>
          )}
        </div>

        <div className="stack">
          {rooms.length > 0 && (
            <div className="card">
              <h2>Remembered rooms</h2>
              <p className="sub">Stored only on this device.</p>
              <div className="remembered">
                {rooms.map((r) => (
                  <RememberedRow
                    key={r.roomId}
                    room={r}
                    onResume={() => onResume(r.roomId)}
                    onInvite={() => {
                      void navigator.clipboard
                        ?.writeText(r.inviteKey)
                        .then(() => toast("Invite key copied"))
                    }}
                    onForget={() => {
                      vault.forget(r.roomId)
                      toast("Room forgotten")
                      setTab(tab)
                    }}
                  />
                ))}
              </div>
            </div>
          )}

          <div className="card">
            <h2>Private by design</h2>
            <p className="sub">What the server can and cannot see.</p>
            <ul className="privacy" style={NO_LIST}>
              <li>
                <Lock size={17} />
                <span>
                  <strong>Encrypted in your browser.</strong> Messages, usernames, captions,
                  filenames, and media are encrypted before upload.
                </span>
              </li>
              <li>
                <ServerOff size={17} />
                <span>
                  <strong>No plaintext on the server.</strong> Cloudflare stores only opaque
                  ciphertext and operational metadata.
                </span>
              </li>
              <li>
                <KeyRound size={17} />
                <span>
                  <strong>Keys live in the link.</strong> The invite secret never reaches the
                  server — lose it and the room is unrecoverable.
                </span>
              </li>
              <li>
                <Shield size={17} />
                <span>
                  <strong>Verify anytime.</strong> Compare safety numbers in-room to confirm no one
                  swapped keys.
                </span>
              </li>
            </ul>
          </div>

          <LockCard />
        </div>
      </div>
    </div>
  )
}

// Optional device passphrase. When enabled, remembered rooms are encrypted at
// rest with a PBKDF2-derived key so device access alone can't reveal them.
function LockCard() {
  const toast = useToast()
  const [enabled, setEnabled] = useState(vault.hasPassphrase())

  async function enable() {
    const p1 = window.prompt("Set a passphrase to encrypt your saved rooms on this device:")
    if (!p1) return
    if (p1.length < 6) {
      toast("Use at least 6 characters.")
      return
    }
    const p2 = window.prompt("Confirm passphrase:")
    if (p2 !== p1) {
      toast("Passphrases did not match.")
      return
    }
    await vault.setPassphrase(p1)
    setEnabled(true)
    toast("Saved rooms are now encrypted on this device.")
  }

  async function disable() {
    const p = window.prompt("Enter your passphrase to remove device encryption:")
    if (!p) return
    const okRemoved = await vault.removePassphrase(p)
    if (okRemoved) {
      setEnabled(false)
      toast("Device passphrase removed.")
    } else {
      toast("Incorrect passphrase.")
    }
  }

  return (
    <div className="card">
      <h2>Device lock</h2>
      <p className="sub">
        {enabled
          ? "Saved rooms on this device are encrypted with your passphrase."
          : "Encrypt saved rooms on this device behind a passphrase."}
      </p>
      <button className="btn btn-block" onClick={() => void (enabled ? disable() : enable())}>
        <Lock size={16} /> {enabled ? "Remove passphrase" : "Protect with passphrase"}
      </button>
    </div>
  )
}

function RememberedRow({
  room,
  onResume,
  onInvite,
  onForget,
}: {
  room: RememberedRoom
  onResume: () => void
  onInvite: () => void
  onForget: () => void
}) {
  const hue = hueFromString(room.roomId)
  const avatarStyle = { background: `hsl(${hue} 60% 45%)` }
  return (
    <div className="room-row">
      <div className="avatar" style={avatarStyle}>
        {initials(room.username)}
      </div>
      <div className="meta">
        <div className="name">{room.username || "anon"}</div>
        <div className="when">Last open {formatRelative(room.lastUsed)}</div>
      </div>
      <div className="row-actions">
        <IconButton icon={<Play size={16} />} label="Resume room" onClick={onResume} />
        <IconButton icon={<KeyRound size={16} />} label="Copy invite key" onClick={onInvite} />
        <IconButton icon={<Trash2 size={16} />} label="Forget room" onClick={onForget} />
      </div>
      <ArrowRight size={0} style={HIDDEN} />
    </div>
  )
}

const SEG_STYLE = { marginBottom: "18px" }
const CHECK_ROW = { alignItems: "flex-start", gap: "10px", marginBottom: "14px", lineHeight: 1.5 }
const STRONG = { color: "var(--text)" }
const MT = { marginTop: "4px" }
const MB = { marginBottom: "14px" }
const NO_LIST = { listStyle: "none", padding: 0, margin: 0 }
const HIDDEN = { display: "none" }
