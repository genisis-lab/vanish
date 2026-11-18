import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
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

/* ---------- Confirm and prompt sheets ---------- */
// In-app replacements for window.confirm and window.prompt, which look like
// browser warnings, can't be styled, and are blocked in some installed apps.

export function ConfirmSheet({
  title,
  icon,
  children,
  confirmLabel,
  danger = false,
  onConfirm,
  onClose,
}: {
  title: string
  icon?: ReactNode
  children?: ReactNode
  confirmLabel: string
  danger?: boolean
  onConfirm: () => void
  onClose: () => void
}) {
  return (
    <Sheet title={title} icon={icon} onClose={onClose}>
      <div className="stack">
        {children}
        <button
          type="button"
          className={`btn btn-block ${danger ? "btn-danger" : "btn-primary"}`}
          onClick={onConfirm}
        >
          {confirmLabel}
        </button>
        <button type="button" className="btn btn-ghost btn-block" onClick={onClose}>
          Cancel
        </button>
      </div>
    </Sheet>
  )
}

export function PromptSheet({
  title,
  icon,
  label,
  hint,
  initialValue = "",
  placeholder,
  maxLength,
  allowEmpty = false,
  confirmLabel = "Save",
  onSubmit,
  onClose,
}: {
  title: string
  icon?: ReactNode
  label: string
  hint?: ReactNode
  initialValue?: string
  placeholder?: string
  maxLength?: number
  /** Saving an empty value is allowed (for example, to clear a topic). */
  allowEmpty?: boolean
  confirmLabel?: string
  /** Called with the trimmed value. */
  onSubmit: (value: string) => void
  onClose: () => void
}) {
  const [value, setValue] = useState(initialValue)
  const inputRef = useRef<HTMLInputElement>(null)
  const id = useId()
  // Runs after the Sheet has mounted and moved focus to its first button.
  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])
  const trimmed = value.trim()
  const canSave = allowEmpty || trimmed.length > 0
  return (
    <Sheet title={title} icon={icon} onClose={onClose}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault()
          if (canSave) onSubmit(trimmed)
        }}
      >
        <div>
          <label className="label" htmlFor={id}>
            {label}
          </label>
          <input
            ref={inputRef}
            id={id}
            className="input"
            value={value}
            placeholder={placeholder}
            maxLength={maxLength}
            autoComplete="off"
            onChange={(e) => setValue(e.target.value)}
          />
        </div>
        {hint && <p className="hint">{hint}</p>}
        <button type="submit" className="btn btn-primary btn-block" disabled={!canSave}>
          {confirmLabel}
        </button>
        <button type="button" className="btn btn-ghost btn-block" onClick={onClose}>
          Cancel
        </button>
      </form>
    </Sheet>
  )
}
