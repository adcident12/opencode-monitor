"use client"

import { useMemo, useState } from "react"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { duration, NEEDS_YOU, rough } from "@/lib/format"
import { useI18n } from "@/lib/i18n"
import type { HistoryEvent } from "@/lib/types"
import { Code } from "./details"
import { StateBadge } from "./state"

export function History({ events }: { events: HistoryEvent[] }) {
  const { t, lang } = useI18n()
  const [onlyAttention, setOnlyAttention] = useState(false)

  const days = useMemo(() => {
    const day = new Intl.DateTimeFormat(lang, { weekday: "long", day: "numeric", month: "long", year: "numeric" })
    const groups: { label: string; events: HistoryEvent[] }[] = []
    for (const e of events) {
      if (onlyAttention && !NEEDS_YOU.has(e.to) && !(e.from && NEEDS_YOU.has(e.from))) continue
      const label = day.format(e.t)
      if (groups.at(-1)?.label !== label) groups.push({ label, events: [] })
      groups.at(-1)!.events.push(e)
    }
    return groups
  }, [events, onlyAttention, lang])

  const time = new Intl.DateTimeFormat(lang, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2.5">
        <Switch id="only-attention" checked={onlyAttention} onCheckedChange={setOnlyAttention} />
        <Label htmlFor="only-attention" className="font-normal text-muted-foreground">
          {t("history.filter")}
        </Label>
      </div>

      {!days.length && (
        <div className="rounded-xl border border-dashed px-6 py-14 text-center">
          <p className="font-medium">{t("history.empty")}</p>
          <p className="mt-1 text-sm text-muted-foreground">{t("history.emptyBody")}</p>
        </div>
      )}

      {days.map(group => (
        <section key={group.label} className="space-y-2">
          <h3 className="text-sm font-medium text-muted-foreground">{group.label}</h3>
          <ol className="divide-y rounded-xl border bg-card">
            {group.events.map(e => {
              const why = t(`reason.${e.reason}`, { permission: e.permission ?? "", limit: e.limitMs ? rough(e.limitMs) : "", detail: e.error ?? "" })
              const before = e.from ? t("history.after", { state: t(`state.${e.from}`), t: duration(e.fromMs ?? 0) }) : t("history.firstSeen")
              return (
                <li key={`${e.id}-${e.t}`} className="grid grid-cols-[4.5rem_1fr] gap-4 px-4 py-3">
                  <time dateTime={new Date(e.t).toISOString()} className="pt-0.5 text-sm tabular-nums text-muted-foreground">
                    {time.format(e.t)}
                  </time>
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <StateBadge state={e.to} label={t(`state.${e.to}`)} className="h-5 text-xs" />
                      <span className="min-w-0 font-medium break-words">{e.title || e.id}</span>
                      <span className="ml-auto font-mono text-[0.78rem] text-muted-foreground">{e.project}</span>
                    </div>
                    <p className="text-[0.82rem]">{why}</p>
                    <p className="text-xs text-muted-foreground">{before}</p>
                    {e.detail && e.to !== "finished" && e.to !== "idle" && <Code className="text-[0.78rem] text-muted-foreground">{e.detail}</Code>}
                  </div>
                </li>
              )
            })}
          </ol>
        </section>
      ))}
    </div>
  )
}
