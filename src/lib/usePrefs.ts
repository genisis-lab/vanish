import { useCallback, useEffect, useState } from "react"

export type Theme = "dark" | "light"

const THEME_KEY = "vanish.theme"
const COMPACT_KEY = "vanish.compact"
const SOUND_KEY = "vanish.sound"

export interface Prefs {
  theme: Theme
  toggleTheme: () => void
  compact: boolean
  toggleCompact: () => void
  sound: boolean
  toggleSound: () => void
}

function initialTheme(): Theme {
  const saved = localStorage.getItem(THEME_KEY) as Theme | null
  if (saved === "dark" || saved === "light") return saved
  return matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"
}

export function usePrefs(): Prefs {
  const [theme, setTheme] = useState<Theme>(initialTheme)
  const [compact, setCompact] = useState<boolean>(() => localStorage.getItem(COMPACT_KEY) === "1")
  const [sound, setSound] = useState<boolean>(() => localStorage.getItem(SOUND_KEY) !== "0")

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem(THEME_KEY, theme)
  }, [theme])

  useEffect(() => {
    localStorage.setItem(COMPACT_KEY, compact ? "1" : "0")
  }, [compact])

  useEffect(() => {
    localStorage.setItem(SOUND_KEY, sound ? "1" : "0")
  }, [sound])

  const toggleTheme = useCallback(() => setTheme((t) => (t === "dark" ? "light" : "dark")), [])
  const toggleCompact = useCallback(() => setCompact((c) => !c), [])
  const toggleSound = useCallback(() => setSound((v) => !v), [])

  return { theme, toggleTheme, compact, toggleCompact, sound, toggleSound }
}
