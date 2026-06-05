import { useState } from "react"
import { Lock } from "lucide-react"
import { vault } from "../lib/vault"

// Shown at startup when the local vault is protected by a passphrase. Unlocking
// decrypts the saved rooms into memory for this session.
export function VaultLock({ onDone }: { onDone: () => void }) {
  const [pass, setPass] = useState("")
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState("")

  async function submit() {
    if (!pass || busy) return
    setBusy(true)
    setErr("")
    const ok = await vault.unlock(pass)
    setBusy(false)
    if (ok) onDone()
    else setErr("Incorrect passphrase — try again.")
  }

  return (
    <div className="center-shell">
      <div className="card join-card" style={CENTER}>
        <Lock size={32} color="var(--accent)" />
        <h2 style={MT}>Unlock your rooms</h2>
        <p className="hint" style={MB}>
          Your saved rooms on this device are protected by a passphrase. It never leaves your
          browser and can't be recovered if forgotten.
        </p>
        <input
          className="input"
          type="password"
          autoFocus
          value={pass}
          placeholder="Passphrase"
          onChange={(e) => setPass(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submit()
          }}
        />
        {err && (
          <p className="hint" style={ERR}>
            {err}
          </p>
        )}
        <button
          className="btn btn-primary btn-block"
          style={MT}
          disabled={busy || !pass}
          onClick={() => void submit()}
        >
          {busy ? "Unlocking…" : "Unlock"}
        </button>
        <button className="btn btn-block" style={MT2} onClick={onDone}>
          Continue without unlocking
        </button>
      </div>
    </div>
  )
}

const CENTER = { textAlign: "center" as const }
const MT = { marginTop: "12px" }
const MT2 = { marginTop: "8px" }
const MB = { marginBottom: "16px" }
const ERR = { color: "var(--danger)", marginTop: "8px" }
