import { useEffect, useState } from "react"
import {
  ArrowRight,
  Clock,
  Flame,
  KeyRound,
  Lock,
  LogIn,
  Moon,
  Pin,
  PinOff,
  Play,
  Plus,
  ServerOff,
  Shield,
  ShieldAlert,
  Smartphone,
  Sun,
  Trash2,
} from "lucide-react"
import type { InviteExpiryOption } from "@shared/types"
import { TTL_PRESETS, ROOM_LIFETIME_PRESETS, DEFAULT_MESSAGE_TTL_MS } from "@shared/constants"
import type { Prefs } from "../lib/usePrefs"
import type { RoomSession } from "../lib/session"
import { createRoom } from "../lib/createRoom"
import { vault, type RememberedRoom } from "../lib/vault"
import { applyDeviceBundle, parseDeviceTransfer } from "../lib/deviceTransfer"
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

const ONBOARD_KEY = "vanish.onboarded.v1"
const INSTALL_DISMISS_KEY = "vanish.pwa-install.dismissed.v1"

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
  const [rooms, setRooms] = useState<RememberedRoom[]>(() => vault.list())
  const [onboarded, setOnboarded] = useState(() => {
    try {
      return localStorage.getItem(ONBOARD_KEY) === "1"
    } catch {
      return true
    }
  })

  function dismissOnboarding() {
    setOnboarded(true)
    try {
      localStorage.setItem(ONBOARD_KEY, "1")
    } catch {
      /* ignore */
    }
  }

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
        participantProof: session.participantProof,
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

      {!onboarded && (
        <div className="card" style={ONBOARD_CARD}>
          <h2>Welcome — three things to know</h2>
          <ul className="privacy" style={NO_LIST}>
            <li>
              <KeyRound size={17} />
              <span>
                <strong>The link IS the key.</strong> Your invite link contains the encryption
                secret — anyone who has it can read the room, and it never touches the server.
              </span>
            </li>
            <li>
              <Clock size={17} />
              <span>
                <strong>Everything vanishes.</strong> Messages and media auto-delete on the timers
                you pick; rooms can self-destruct entirely.
              </span>
            </li>
            <li>
              <Shield size={17} />
              <span>
                <strong>Trust, then verify.</strong> Inside a room, tap the shield to compare safety
                numbers and confirm no one swapped keys.
              </span>
            </li>
          </ul>
          <button className="btn btn-primary" style={MT} onClick={dismissOnboarding}>
            Got it
          </button>
        </div>
      )}

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
          <MobileInstallCard />

          {rooms.length > 0 && (
            <div className="card">
              <h2>Remembered rooms</h2>
              <p className="sub">Stored only on this device. Pinned rooms stay on top.</p>
              <div className="remembered">
                {rooms.map((r) => (
                  <RememberedRow
                    key={r.roomId}
                    room={r}
                    onResume={() => onResume(r.roomId)}
                    onPin={() => {
                      vault.setPinned(r.roomId, !r.pinned)
                      setRooms(vault.list())
                    }}
                    onInvite={() => {
                      void navigator.clipboard
                        ?.writeText(r.inviteKey)
                        .then(() => toast("Invite key copied"))
                    }}
                    onForget={() => {
                      vault.forget(r.roomId)
                      toast("Room forgotten")
                      setRooms(vault.list())
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

          <DeviceTransferCard onResume={onResume} />

          <LockCard />
        </div>
      </div>
    </div>
  )
}

function MobileInstallCard() {
  const [platform, setPlatform] = useState<"ios" | "android" | null>(null)
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(INSTALL_DISMISS_KEY) === "1"
    } catch {
      return true
    }
  })

  useEffect(() => {
    const update = () => setPlatform(detectMobileInstallPlatform())
    update()

    const standaloneQuery = window.matchMedia?.("(display-mode: standalone)")
    standaloneQuery?.addEventListener?.("change", update)
    window.addEventListener("appinstalled", update)
    window.addEventListener("resize", update)
    return () => {
      standaloneQuery?.removeEventListener?.("change", update)
      window.removeEventListener("appinstalled", update)
      window.removeEventListener("resize", update)
    }
  }, [])

  if (dismissed || !platform) return null

  const steps =
    platform === "ios"
      ? ["Tap Share in the browser bar.", "Choose Add to Home Screen.", "Open Vanish from the new icon."]
      : ["Open the browser menu.", "Choose Install app or Add to Home screen.", "Open Vanish from the new icon."]

  function dismiss() {
    setDismissed(true)
    try {
      localStorage.setItem(INSTALL_DISMISS_KEY, "1")
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="card">
      <h2>Install Vanish</h2>
      <p className="sub">Keep it on your Home Screen for a steadier mobile chat window.</p>
      <ol className="steps" style={INSTALL_STEPS}>
        {steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      <button className="btn btn-block" onClick={dismiss}>
        <Smartphone size={16} /> Done
      </button>
      <button className="btn btn-ghost btn-block" style={MT} onClick={dismiss}>
        Not now
      </button>
    </div>
  )
}

function detectMobileInstallPlatform(): "ios" | "android" | null {
  if (isStandaloneDisplay()) return null

  const ua = navigator.userAgent
  const iPadOS = navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1
  const ios = /iPad|iPhone|iPod/i.test(ua) || iPadOS
  const android = /Android/i.test(ua)
  const coarseMobile =
    window.matchMedia?.("(pointer: coarse)").matches && Math.min(window.innerWidth, window.innerHeight) < 900

  if (ios) return "ios"
  if (android || coarseMobile) return "android"
  return null
}

function isStandaloneDisplay() {
  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    (navigator as unknown as { standalone?: boolean }).standalone === true
  )
}

// Optional device passphrase. When enabled, remembered rooms are encrypted at
// rest with a PBKDF2-derived key so device access alone can't reveal them.
// Optionally pairs with a duress passphrase: entering it at the unlock screen
// silently wipes all saved rooms instead of revealing them.
function LockCard() {
  const toast = useToast()
  const [enabled, setEnabled] = useState(vault.hasPassphrase())
  const [duress, setDuress] = useState(vault.hasDuress())

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
      vault.removeDuressPassphrase()
      setEnabled(false)
      setDuress(false)
      toast("Device passphrase removed.")
    } else {
      toast("Incorrect passphrase.")
    }
  }

  async function setupDuress() {
    const p1 = window.prompt(
      "Set a DURESS passphrase. Entering it at the unlock screen will silently and permanently wipe all saved rooms on this device:",
    )
    if (!p1) return
    if (p1.length < 4) {
      toast("Use at least 4 characters.")
      return
    }
    const p2 = window.prompt("Confirm duress passphrase:")
    if (p2 !== p1) {
      toast("Passphrases did not match.")
      return
    }
    await vault.setDuressPassphrase(p1)
    setDuress(true)
    toast("Duress passphrase set — entering it at unlock wipes saved rooms.")
  }

  function clearDuress() {
    vault.removeDuressPassphrase()
    setDuress(false)
    toast("Duress passphrase removed.")
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
      {enabled && (
        <>
          <button
            className="btn btn-block"
            style={MT}
            onClick={() => void (duress ? clearDuress() : setupDuress())}
          >
            <ShieldAlert size={16} /> {duress ? "Remove duress passphrase" : "Add duress passphrase"}
          </button>
          <p className="hint" style={MT}>
            A duress passphrase is a decoy: typed at the unlock screen, it looks like a normal
            unlock but permanently erases every saved room on this device.
          </p>
        </>
      )}
    </div>
  )
}

// Import a room from another device using a PIN-locked transfer code (generated
// in that device's "Verify encryption" panel). Brings over the room key,
// participant identity, signing key and — if present — owner rights.
function DeviceTransferCard({ onResume }: { onResume: (roomId: string) => void }) {
  const toast = useToast()
  const [busy, setBusy] = useState(false)

  async function importFromDevice() {
    if (busy) return
    const code = window.prompt("Paste the device-transfer code from your other device:")
    if (!code) return
    const pin = window.prompt("Enter the transfer PIN shown on your other device:")
    if (!pin) return
    setBusy(true)
    try {
      const bundle = await parseDeviceTransfer(code, pin)
      const { roomId } = applyDeviceBundle(bundle)
      toast("Room added to this device")
      onResume(roomId)
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not import transfer code")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card">
      <h2>Add from another device</h2>
      <p className="sub">
        Already in this room on another device? Move it here — keys, owner rights and identity travel
        inside a PIN-locked code.
      </p>
      <button className="btn btn-block" disabled={busy} onClick={() => void importFromDevice()}>
        <Smartphone size={16} /> Import device transfer
      </button>
    </div>
  )
}

function RememberedRow({
  room,
  onResume,
  onPin,
  onInvite,
  onForget,
}: {
  room: RememberedRoom
  onResume: () => void
  onPin: () => void
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
        <IconButton
          icon={room.pinned ? <PinOff size={16} /> : <Pin size={16} />}
          label={room.pinned ? "Unpin room" : "Pin room to top"}
          onClick={onPin}
          active={!!room.pinned}
        />
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
const INSTALL_STEPS = { marginTop: 0, marginBottom: "14px" }
const HIDDEN = { display: "none" }
const ONBOARD_CARD = { marginBottom: "18px" }
