import { AlertTriangle, CheckCircle2, EyeOff, ShieldCheck } from "lucide-react"
import { Sheet } from "./ui"

export function SecurityTransparency({ onClose }: { onClose: () => void }) {
  return (
    <Sheet title="Security transparency" icon={<ShieldCheck size={18} />} onClose={onClose}>
      <div className="transparency-grid">
        <section className="callout">
          <CheckCircle2 size={18} />
          <span>
            <strong>Encrypted content.</strong> Messages, names, captions, filenames, reactions,
            and media bytes are encrypted before upload.
          </span>
        </section>
        <section className="callout">
          <EyeOff size={18} />
          <span>
            <strong>Server metadata.</strong> Room IDs, object sizes, timing, IP-level network
            metadata, and delivery endpoints can still exist operationally.
          </span>
        </section>
        <section className="callout">
          <ShieldCheck size={18} />
          <span>
            <strong>Authority split.</strong> Room access, participant actions, and owner controls
            use separate proofs so a room member cannot claim another participant or owner action.
          </span>
        </section>
        <section className="callout warn">
          <AlertTriangle size={18} />
          <span>
            <strong>Known limits.</strong> Bans remove a participant identity, not the shared
            invite secret. Device transfer codes and push endpoints should be shared only with
            devices and services you trust.
          </span>
        </section>
      </div>
    </Sheet>
  )
}
