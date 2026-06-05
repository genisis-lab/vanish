import { useEffect, useState } from "react"
import { ArrowLeft, CheckCircle2, Flame, LogIn, XCircle } from "lucide-react"
import { deriveKeys } from "@shared/crypto"
import type { ParsedInvite } from "@shared/invite"
import type { ValidateInviteResponse } from "@shared/types"
import { api, ApiError } from "../lib/api"
import { buildSession, type RoomSession } from "../lib/session"
import type { Prefs } from "../lib/usePrefs"
import { vault } from "../lib/vault"
import { IconButton, useToast } from "./ui"
import { InstallPrompt } from "./InstallPrompt"

type Status = "checking" | "valid" | "invalid" | "expired" | "error"

export function InviteJoin({
  invite,
  prefs,
  onJoined,
  onCancel,
}: {
  invite: ParsedInvite
  prefs: Prefs
  onJoined: (s: RoomSession) => void
  onCancel: () => void
}) {
  const toast = useToast()
  const remembered = vault.get(invite.roomId)
  const [status, setStatus] = useState<Status>("checking")
  const [accessProofHash, setAccessProofHash] = useState("")
  const [username, setUsername] = useState(remembered?.username ?? "")
  const [busy, setBusy] = useState(false)
  const [showInstall, setShowInstall] = useState(Boolean(import.meta.env.VITE_IPA_DOWNLOAD_URL))

  useEffect(() => {
    let cancelled = false
    async function check() {
      try {
        const keys = await deriveKeys(invite.secret, invite.roomId)
        if (cancelled) return
        setAccessProofHash(keys.accessProofHash)
        const res: ValidateInviteResponse = await api.validateInvite({
          roomId: invite.roomId,
          accessProofHash: keys.accessProofHash,
        })
        if (cancelled) return
        setStatus(res.status === "deleted" ? "invalid" : res.status)
      } catch (e) {
        if (!cancelled) setStatus(e instanceof ApiError && e.status === 404 ? "invalid" : "error")
      }
    }
    void check()
    return () => {
      cancelled = true
    }
  }, [invite])

  async function join() {
    if (busy) return
    setBusy(true)
    try {
      const session = await buildSession(invite, username, remembered?.participantId)
      vault.save({
        roomId: invite.roomId,
        inviteKey: invite.inviteKey,
        username: session.username,
        participantId: session.participantId,
        lastUsed: Date.now(),
        verifiedSafetyNumber: remembered?.verifiedSafetyNumber,
      })
      onJoined(session)
    } catch {
      toast("Could not join. Try again.")
      setBusy(false)
    }
  }

  const canJoin = status === "valid" && username.trim().length > 0 && !busy
  void accessProofHash

  return (
    <div className="center-shell">
      {showInstall && <InstallPrompt onSkip={() => setShowInstall(false)} />}
      <div className="card join-card">
        <div className="brand" style={BRAND}>
          <span className="spark">
            <Flame size={18} />
          </span>
          Join encrypted room
        </div>

        {status === "checking" && (
          <div className="status-banner" style={BANNER}>
            <span className="spinner" /> Validating invite…
          </div>
        )}
        {status === "valid" && (
          <div className="status-banner valid">
            <CheckCircle2 size={18} /> Invite is valid. Choose a name to enter.
          </div>
        )}
        {status === "invalid" && (
          <div className="status-banner invalid">
            <XCircle size={18} /> This invite is invalid or the room no longer exists.
          </div>
        )}
        {status === "expired" && (
          <div className="status-banner expired">
            <XCircle size={18} /> This invite has expired. New joins are blocked.
          </div>
        )}
        {status === "error" && (
          <div className="status-banner invalid">
            <XCircle size={18} /> Couldn't reach the server. Check your connection.
          </div>
        )}

        <div className="field">
          <label className="label" htmlFor="jn">
            Display name
          </label>
          <input
            id="jn"
            className="input"
            placeholder="e.g. quiet-harbor"
            value={username}
            maxLength={32}
            disabled={status !== "valid"}
            onChange={(e) => setUsername(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && canJoin && join()}
            autoComplete="off"
          />
        </div>

        <button className="btn btn-primary btn-block" disabled={!canJoin} onClick={join} style={MB}>
          {busy ? <span className="spinner" /> : <LogIn size={17} />}
          {busy ? "Joining…" : "Join room"}
        </button>
        <button className="btn btn-ghost btn-block" onClick={onCancel}>
          <ArrowLeft size={16} /> Back to home
        </button>

        <p className="hint" style={MT}>
          Your name and messages are encrypted in your browser before upload. The server validates
          access using only a one-way hash of your key.
        </p>
      </div>
    </div>
  )
}

const BRAND = { marginBottom: "18px", fontSize: "17px" }
const BANNER = { background: "var(--bg-soft)", color: "var(--text-dim)" }
const MB = { marginBottom: "10px" }
const MT = { marginTop: "16px" }
