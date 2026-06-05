import { useEffect, useState } from "react"
import { Copy, KeyRound, Link2, QrCode } from "lucide-react"
import { buildInviteUrl } from "@shared/invite"
import type { RoomSession } from "../lib/session"
import type { Prefs } from "../lib/usePrefs"
import { toQrDataUrl } from "../lib/qr"
import { Sheet, useToast } from "./ui"

export function InvitePanel({
  session,
  prefs,
  initialQr = false,
  onClose,
}: {
  session: RoomSession
  prefs: Prefs
  initialQr?: boolean
  onClose: () => void
}) {
  const toast = useToast()
  const [showQr, setShowQr] = useState(initialQr)
  const [qr, setQr] = useState<string | null>(null)
  const inviteUrl = buildInviteUrl(window.location.origin, session.invite.inviteKey)

  useEffect(() => {
    if (showQr && !qr) void toQrDataUrl(inviteUrl, prefs.theme === "dark").then(setQr)
  }, [showQr, qr, inviteUrl, prefs.theme])

  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text)
      toast(`${what} copied`)
    } catch {
      toast("Copy failed — select and copy manually")
    }
  }

  return (
    <Sheet title="Invite to room" icon={<Link2 size={18} />} onClose={onClose}>
      <p className="hint" style={MB}>
        Anyone with this link can join and decrypt the conversation. Share it only with people you
        trust.
      </p>

      <span className="label">Invite link</span>
      <div className="copy-field" style={MB}>
        <div className="box mono">{inviteUrl}</div>
        <button className="btn" onClick={() => copy(inviteUrl, "Link")} aria-label="Copy invite link">
          <Copy size={16} />
        </button>
      </div>

      <button className="btn btn-block" style={MB} onClick={() => copy(session.invite.inviteKey, "Key")}>
        <KeyRound size={16} /> Copy raw invite key
      </button>

      <button className="btn btn-block" onClick={() => setShowQr((v) => !v)} aria-expanded={showQr}>
        <QrCode size={16} /> {showQr ? "Hide QR code" : "Show QR code"}
      </button>

      {showQr && (
        <div className="qr-wrap" style={MT}>
          {qr ? <img src={qr} alt="Invite QR code" /> : <span className="spinner" />}
        </div>
      )}
    </Sheet>
  )
}

const MB = { marginBottom: "14px" }
const MT = { marginTop: "14px" }
