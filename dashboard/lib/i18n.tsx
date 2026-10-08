"use client"

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react"
// English is bundled so the first paint already has real words; other languages load on demand.
import english from "../../i18n/en.json"

// UI strings live in ../i18n/<lang>.json at the repository root, shared with the server's
// notifications, and are fetched from the monitor at run time.
export const LANGUAGES = [
  { code: "en", label: "English" },
  { code: "th", label: "ไทย" },
] as const
export type Lang = (typeof LANGUAGES)[number]["code"]

type Strings = Record<string, string>
type Translate = (key: string, vars?: Record<string, string | number>) => string

interface I18n {
  lang: Lang
  setLang: (lang: Lang) => void
  t: Translate
}

const Context = createContext<I18n | null>(null)

const isLang = (value: unknown): value is Lang => LANGUAGES.some(l => l.code === value)

function initialLang(): Lang {
  const fromUrl = new URLSearchParams(window.location.search).get("lang")
  if (isLang(fromUrl)) return fromUrl
  try {
    const saved = localStorage.getItem("lang")
    if (isLang(saved)) return saved
  } catch {
    // Storage can be unavailable; fall through.
  }
  const fromBrowser = navigator.language.slice(0, 2)
  return isLang(fromBrowser) ? fromBrowser : "en"
}

async function load(code: Lang): Promise<Strings> {
  const res = await fetch(`/i18n/${code}.json`)
  if (!res.ok) throw new Error(`i18n ${code}: HTTP ${res.status}`)
  return res.json()
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>("en")
  const [strings, setStrings] = useState<Strings>(english)

  // The saved or browser language is only known in the browser. Its strings are fetched
  // first and the switch happens when they arrive, so the page never shows bare keys.
  useEffect(() => {
    const wanted = initialLang()
    if (wanted === "en") return
    load(wanted)
      .then(s => {
        setStrings(s)
        setLangState(wanted)
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    document.documentElement.lang = lang
  }, [lang])

  const setLang = useCallback((next: Lang) => {
    const apply = (s: Strings) => {
      setStrings(s)
      setLangState(next)
    }
    if (next === "en") apply(english)
    else load(next).then(apply).catch(() => {})
    try {
      localStorage.setItem("lang", next)
    } catch {
      // The choice just will not be remembered.
    }
  }, [])

  const t = useCallback<Translate>(
    (key, vars = {}) => (strings[key] ?? (english as Strings)[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? "")),
    [strings],
  )

  const value = useMemo(() => ({ lang, setLang, t }), [lang, setLang, t])
  return <Context.Provider value={value}>{children}</Context.Provider>
}

export function useI18n(): I18n {
  const value = useContext(Context)
  if (!value) throw new Error("useI18n outside I18nProvider")
  return value
}
