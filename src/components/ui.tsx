import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { createPortal } from "react-dom"
import { X } from "lucide-react"

/* ---------- Toast ---------- */
const ToastCtx = createContext<(msg: string) => void>(() => {})
export const useToast = () => useContext(ToastCtx)

export function ToastProvider({ children }: { children: ReactNode }) {
  const [msg, setMsg] = useState<string | null>(null)
  const show = useCallback((m: string) => setMsg(m), [])
  useEffect(() => {
    if (!msg) return
    const t = setTimeout(() => setMsg(null), 2200)
    return () => clearTimeout(t)
  }, [msg])
  return (
    <ToastCtx.Provider value={show}>
      {children}
      {msg && (
        <div className="toast" role="status">
          {msg}
        </div>
      )}
    </ToastCtx.Provider>
  )
}

/* ---------- Icon button ---------- */
export function IconButton({
  icon,
  label,
  onClick,
  active,
  className = "",
}: {
  icon: ReactNode
  label: string
  onClick?: () => void
  active?: boolean
  className?: string
}) {
  return (
    <button
      type="button"
      className={`icon-btn ${active ? "active" : ""} ${className}`}
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
    >
      {icon}
    </button>
  )
}

/* ---------- Modal sheet ---------- */
export function Sheet({
  title,
  icon,
  onClose,
  children,
}: {
  title: string
  icon?: ReactNode
  onClose: () => void
  children: ReactNode
}) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  if (!hostRef.current) hostRef.current = document.createElement("div")
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const sheetRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const host = hostRef.current!
    const previous = document.activeElement as HTMLElement | null
    document.body.appendChild(host)
    const backgrounds = [...document.body.children].filter(
      (el): el is HTMLElement => el instanceof HTMLElement && el !== host,
    )
    const states = backgrounds.map((el) => ({ el, inert: el.inert }))
    backgrounds.forEach((el) => {
      el.inert = true
    })
    const overflow = document.body.style.overflow
    document.body.style.overflow = "hidden"
    const focusable = () =>
      [
        ...(sheetRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"], audio[controls], video[controls]',
        ) ?? []),
      ].filter((el) => !el.hidden && el.getClientRects().length > 0)
    ;(focusable()[0] ?? sheetRef.current)?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault()
        e.stopPropagation()
        closeRef.current()
        return
      }
      if (e.key !== "Tab") return
      const nodes = focusable()
      const first = nodes[0],
        last = nodes[nodes.length - 1]
      if (!first) {
        e.preventDefault()
        sheetRef.current?.focus()
        return
      }
      if (
        !sheetRef.current?.contains(document.activeElement) ||
        (e.shiftKey && document.activeElement === first)
      ) {
        e.preventDefault()
        ;(e.shiftKey ? last : first).focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener("keydown", onKey, true)
    return () => {
      document.removeEventListener("keydown", onKey, true)
      states.forEach(({ el, inert }) => {
        el.inert = inert
      })
      document.body.style.overflow = overflow
      host.remove()
      if (previous?.isConnected) previous.focus()
    }
  }, [])
  return createPortal(
    <div className="scrim" onClick={onClose}>
      <div
        ref={sheetRef}
        className="sheet"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
      >
        <div className="sheet-head">
          {icon}
          <h3>{title}</h3>
          <IconButton icon={<X size={18} />} label="Close" onClick={onClose} />
        </div>
        <div className="sheet-body">{children}</div>
      </div>
    </div>,
    hostRef.current,
  )
}
