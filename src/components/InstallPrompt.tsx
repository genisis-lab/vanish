import { Download, Smartphone } from "lucide-react"
import { Sheet } from "./ui"

// Shown on the invite page only when VITE_IPA_DOWNLOAD_URL is configured.
export function InstallPrompt({ onSkip }: { onSkip: () => void }) {
  const ipaUrl = import.meta.env.VITE_IPA_DOWNLOAD_URL
  if (!ipaUrl) return null
  return (
    <Sheet title="Install the app" icon={<Smartphone size={18} />} onClose={onSkip}>
      <p className="hint" style={MB}>
        For the best experience, install the IPA on your device.
      </p>
      <ol className="steps">
        <li>Download the IPA.</li>
        <li>Open it on your iPhone.</li>
        <li>Trust the developer profile in Settings if required.</li>
        <li>Reopen the app and continue with the invite.</li>
      </ol>
      <a className="btn btn-primary btn-block" href={ipaUrl} style={MB}>
        <Download size={16} /> Download IPA
      </a>
      <button className="btn btn-ghost btn-block" onClick={onSkip}>
        Skip for now
      </button>
    </Sheet>
  )
}

const MB = { marginBottom: "14px" }
