import { useCallback, useEffect, useState } from "react"

export type Theme = "dark" | "light"

const THEME_KEY = "vanish.theme"
const COMPACT_KEY = "vanish.compact"

export interface Prefs {
  theme: Theme
  toggleTheme: () => void
  compact: boolean
  toggleCompact: () => void
}

function initialTheme(): Theme {
  const saved = localStorage.getItem(THEME_KEY) as Theme | null
  if (saved === "dark" || saved === "light") return saved
  return matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"
}

export function usePrefs(): Prefs {
  const [theme, setTheme] = useState<Theme>(initialTheme)
  const [compact, setCompact] = useState<boolean>(() => localStorage.getItem(COMPACT_KEY) === "1")

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem(THEME_KEY, theme)
  }, [theme])

  useEffect(() => {
    localStorage.setItem(COMPACT_KEY, compact ? "1" : "0")
  }, [compact])

  const toggleTheme = useCallback(() => setTheme((t) => (t === "dark" ? "light" : "dark")), [])
  const toggleCompact = useCallback(() => setCompact((c) => !c), [])

  return { theme, toggleTheme, compact, toggleCompact }
}
