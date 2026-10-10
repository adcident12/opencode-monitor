"use client"

import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react"
import { useTheme } from "next-themes"
import { useSyncExternalStore } from "react"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { LANGUAGES, useI18n, type Lang } from "@/lib/i18n"
import type { Snapshot } from "@/lib/types"
import type { MarkTone } from "@/lib/logo"
import { Logo } from "./logo"
import { Hint } from "./hint"
import { Dot, toneOf } from "./state"

const RUNNING_KEY = { ok: "oc.running", bad: "oc.stopped", unknown: "oc.unknown" } as const

function connectionKey(connected: boolean, stale: boolean | undefined) {
  if (!connected) return "conn.lost"
  return stale ? "conn.stale" : "conn.live"
}

/** @param tone  what the sessions are doing, shown as the dot of the mark */
export function Header({ snapshot, connected, tone }: Readonly<{ snapshot: Snapshot | null; connected: boolean; tone: MarkTone }>) {
  const { t, lang, setLang } = useI18n()
  const live = connected && !snapshot?.stale
  const running = snapshot?.opencodeRunning

  return (
    <header className="flex flex-wrap items-center gap-x-6 gap-y-3">
      <div className="mr-auto flex items-center gap-2.5">
        <Logo tone={tone} />
        <h1 className="text-lg font-semibold">{t("app.title")}</h1>
        {/* Which version is running, so "is this the new one?" needs no terminal. */}
        {snapshot?.version && (
          <Hint label={t("app.version", { v: snapshot.version })} className="text-xs tabular-nums text-muted-foreground">
            v{snapshot.version}
          </Hint>
        )}
      </div>

      <output className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-muted-foreground">
        <span className="inline-flex items-center gap-2">
          <Dot tone={live ? "ok" : "bad"} />
          {t(connectionKey(connected, snapshot?.stale))}
        </span>
        <span className="inline-flex items-center gap-2">
          <Dot tone={toneOf(running)} />
          {t(RUNNING_KEY[toneOf(running)])}
        </span>
      </output>

      <div className="flex items-center gap-2">
        <Select value={lang} onValueChange={value => setLang(value as Lang)} items={LANGUAGES.map(l => ({ value: l.code, label: l.label }))}>
          <SelectTrigger size="sm" aria-label={t("app.language")} className="min-w-24">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {LANGUAGES.map(l => (
              <SelectItem key={l.code} value={l.code}>
                {l.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <ThemeMenu />
      </div>
    </header>
  )
}

const noSubscribe = () => () => {}

function ThemeMenu() {
  const { t } = useI18n()
  const { theme, setTheme, resolvedTheme } = useTheme()
  // The theme is only known in the browser; render a neutral icon until then.
  const mounted = useSyncExternalStore(noSubscribe, () => true, () => false)
  const themed = resolvedTheme === "dark" ? MoonIcon : SunIcon
  const Icon = mounted ? themed : MonitorIcon

  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="outline" size="icon-sm" aria-label={t("theme.label")} />}>
        <Icon />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-36">
        <DropdownMenuRadioGroup value={mounted ? theme : "system"} onValueChange={value => setTheme(String(value))}>
          <DropdownMenuRadioItem value="light">{t("theme.light")}</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">{t("theme.dark")}</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system">{t("theme.system")}</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
