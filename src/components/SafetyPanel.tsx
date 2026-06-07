import { useEffect, useState } from "react"
import { BadgeCheck, Copy, Fingerprint, ShieldAlert, Smartphone } from "lucide-react"
import { exportSigningKeyPair, signingFingerprint } from "@shared/crypto"
import type { RoomSession } from "../lib/session"
import type { Prefs } from "../lib/usePrefs"
import { toQrDataUrl } from "../lib/qr"
import { buildDeviceTransfer } from "../lib/deviceTransfer"
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
  const [fingerprint, setFingerprint] = useState<string | null>(null)
  const [verifiedAt, setVerifiedAt] = useState<string | undefined>(
    () => vault.get(session.invite.roomId)?.verifiedSafetyNumber,
  )
  const [transfer, setTransfer] = useState<string | null>(null)
  const [transferQr, setTransferQr] = useState<string | null>(null)
  const [transferPin, setTransferPin] = useState<string | null>(null)
  const [preparing, setPreparing] = useState(false)
  const changed = verifiedAt !== undefined && verifiedAt !== safetyNumber

  useEffect(() => {
    void toQrDataUrl("vanish-safety:" + safetyNumber, prefs.theme === "dark").then(setQr)
  }, [safetyNumber, prefs.theme])

  useEffect(() => {
    if (!session.signing) {
      setFingerprint(null)
      return
    }
    void signingFingerprint(session.signing.publicKeyB64).then(setFingerprint)
  }, [session.signing])

  const markVerified = () => {
    vault.setVerified(session.invite.roomId, safetyNumber)
    setVerifiedAt(safetyNumber)
    toast("Marked as verified on this device")
  }

  // Prepare an ephemeral, PIN-locked transfer code so this room (its keys,
  // identity and — if you are the owner — owner rights) can be added to another
  // device by scanning the QR or pasting the code and entering the PIN.
  const startTransfer = async () => {
    if (preparing) return
    setPreparing(true)
    try {
      const pinBytes = new Uint32Array(1)
      globalThis.crypto.getRandomValues(pinBytes)
      const pin = String(100000 + (pinBytes[0] % 900000))
      const signing = session.signing ? await exportSigningKeyPair(session.signing) : null
      const token = await buildDeviceTransfer(
        {
          inviteKey: session.invite.inviteKey,
          username: session.username,
          participantId: session.participantId,
          ownerSecret: session.ownerSecret,
          signing: signing ?? undefined,
        },
        pin,
      )
      setTransferPin(pin)
      setTransfer(token)
      setTransferQr(await toQrDataUrl(token, prefs.theme === "dark"))
    } catch {
      toast("Could not prepare the transfer code")
    } finally {
      setPreparing(false)
    }
  }

  const copyTransfer = async () => {
    if (!transfer) return
    try {
      await navigator.clipboard.writeText(transfer)
      toast("Transfer code copied")
    } catch {
      toast("Copy failed — select and copy manually")
    }
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

      {fingerprint && (
        <div style={MB}>
          <span className="label">Your sender fingerprint</span>
          <div className="safety-num">{fingerprint}</div>
        </div>
      )}

      <button className="btn btn-primary btn-block" style={MB} onClick={markVerified}>
        <BadgeCheck size={16} /> Mark as verified
      </button>

      <span className="label">Multi-device</span>
      <button
        className="btn btn-block"
        style={MT_SM}
        disabled={preparing}
        onClick={() => void startTransfer()}
      >
        <Smartphone size={16} /> {transfer ? "Regenerate transfer code" : "Move room to another device"}
      </button>

      {transfer && (
        <div className="transfer-block">
          <span className="label">1. Scan this on your other device</span>
          <div className="qr-wrap">
            {transferQr ? (
              <img src={transferQr} alt="Device transfer QR code" />
            ) : (
              <span className="spinner" />
            )}
          </div>

          <span className="label">2. Enter this PIN there</span>
          <div className="transfer-pin">{transferPin}</div>

          <span className="label">No camera? Copy the code and paste it instead</span>
          <div className="transfer-code mono">{transfer}</div>
          <button className="btn btn-block" onClick={() => void copyTransfer()}>
            <Copy size={16} /> Copy transfer code
          </button>

          <p className="hint">
            This code grants full access to the room (and owner rights, if you have them). Share it
            only with your own device, and close this panel to expire it.
          </p>
        </div>
      )}

      <div className="callout" style={MT}>
        <span>
          <strong style={STRONG}>How this works.</strong> Messages, usernames, captions, filenames,
          and media are encrypted in your browser before upload, using keys derived from the invite
          secret. Compare this safety number with another participant (read it aloud or scan the QR)
          — if they match, no one has tampered with the keys. Each device also signs every message
          it sends with a per-session key, so you will see a warning on any message whose signature
          does not check out or whose sender's key changes mid-conversation. Cloudflare may still
          process operational metadata such as IP addresses, timestamps, room IDs, and object sizes.
        </span>
      </div>
    </Sheet>
  )
}

const MB = { marginBottom: "14px" }
const MARGIN = { margin: "14px 0" }
const MT = { marginTop: "14px" }
const MT_SM = { marginTop: "8px" }
const STRONG = { color: "var(--text)" }
