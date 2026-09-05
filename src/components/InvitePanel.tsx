import { useEffect, useState } from "react"
import { Copy, KeyRound, Link2, QrCode, Share2, Check } from "lucide-react"
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
  const [copied, setCopied] = useState(false)
  const [shareError, setShareError] = useState("")
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
      if (what === "Link") setCopied(true)
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

      {typeof navigator.share === "function" && (
        <button
          className="btn btn-primary btn-block invite-share"
          onClick={async () => {
            setShareError("")
            try {
              await navigator.share({ title: "Join my Vanish room", url: inviteUrl })
            } catch (error) {
              if (!(error instanceof DOMException && error.name === "AbortError"))
                setShareError("Could not open sharing. Copy the invite link below instead.")
            }
          }}
        >
          <Share2 size={16} /> Share invite
        </button>
      )}
      {shareError && (
        <p className="inline-error" role="alert">
          {shareError}
        </p>
      )}
      <span className="label">Invite link</span>
      <div className="copy-field" style={MB}>
        <div className="box mono">{inviteUrl}</div>
        <button
          className="btn"
          onClick={() => copy(inviteUrl, "Link")}
          aria-label="Copy invite link"
        >
          {copied ? <Check size={16} /> : <Copy size={16} />}
        </button>
      </div>

      {copied && (
        <p role="status" className="hint">
          Invite link copied. Anyone with it can open this room.
        </p>
      )}

      <button
        className="btn btn-block"
        style={MB}
        onClick={() => copy(session.invite.inviteKey, "Key")}
      >
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
