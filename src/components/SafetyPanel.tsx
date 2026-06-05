import { useEffect, useState } from "react"
import { BadgeCheck, Fingerprint, ShieldAlert } from "lucide-react"
import type { RoomSession } from "../lib/session"
import type { Prefs } from "../lib/usePrefs"
import { toQrDataUrl } from "../lib/qr"
import { vault } from "../lib/vault"
import { Sheet, useToast } from "./ui"

export function SafetyPanel({
  session,
  prefs,
  onClose,
}: {
  session: RoomSession
  prefs: Prefs
  onClose: () => void
}) {
  const toast = useToast()
  const safetyNumber = session.keys.safetyNumber
  const [qr, setQr] = useState<string | null>(null)
  const [verifiedAt, setVerifiedAt] = useState<string | undefined>(
    () => vault.get(session.invite.roomId)?.verifiedSafetyNumber,
  )
  const changed = verifiedAt !== undefined && verifiedAt !== safetyNumber

  useEffect(() => {
    void toQrDataUrl("vanish-safety:" + safetyNumber, prefs.theme === "dark").then(setQr)
  }, [safetyNumber, prefs.theme])

  const markVerified = () => {
    vault.setVerified(session.invite.roomId, safetyNumber)
    setVerifiedAt(safetyNumber)
    toast("Marked as verified on this device")
  }

  return (
    <Sheet title="Verify encryption" icon={<Fingerprint size={18} />} onClose={onClose}>
      {changed && (
        <div className="callout warn" style={MB}>
          <ShieldAlert size={18} />
          <span>
            The safety number changed since you last verified it. This can happen if someone
            rejoined with a different key. Re-verify before trusting this room.
          </span>
        </div>
      )}
      {!changed && verifiedAt !== undefined && (
        <div className="badge-verified" style={MB}>
          <BadgeCheck size={16} /> You verified this room on this device.
        </div>
      )}

      <span className="label">Safety number</span>
      <div className="safety-num">{safetyNumber}</div>

      <div className="qr-wrap" style={MARGIN}>
        {qr ? <img src={qr} alt="Safety verification QR code" /> : <span className="spinner" />}
      </div>

      <button className="btn btn-primary btn-block" style={MB} onClick={markVerified}>
        <BadgeCheck size={16} /> Mark as verified
      </button>

      <div className="callout">
        <span>
          <strong style={STRONG}>How this works.</strong> Messages, usernames, captions, filenames,
          and media are encrypted in your browser before upload, using keys derived from the invite
          secret. Compare this safety number with another participant (read it aloud or scan the QR)
          — if they match, no one has tampered with the keys. Cloudflare may still process
          operational metadata such as IP addresses, timestamps, room IDs, and object sizes.
        </span>
      </div>
    </Sheet>
  )
}

const MB = { marginBottom: "14px" }
const MARGIN = { margin: "14px 0" }
const STRONG = { color: "var(--text)" }
