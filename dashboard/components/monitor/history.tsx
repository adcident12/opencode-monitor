"use client"

import { useMemo, useState } from "react"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { compact, duration, rough } from "@/lib/format"
import { cn } from "@/lib/utils"
import { DownloadIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { download, sessionsCsv } from "@/lib/csv"
import { useI18n } from "@/lib/i18n"
import { useHistory, useHistorySessions, useStats } from "@/lib/live"
import type { HistoryEvent, Stats } from "@/lib/types"
import { Code } from "./details"
import { SessionFilter } from "./session-filter"
import { StateBadge } from "./state"

const EFFORT_DAYS = 30
const EFFORT_ROWS = 8

/**
 * Which sessions took the most: agent time, time waiting for you, compactions, tokens. A
 * row picks that session for the list below; with one picked, only its row is shown.
 */
function Effort({ rows, selected, onSelect }: { rows: Stats["sessions"]; selected: string | null; onSelect: (id: string | null) => void }) {
  const { t } = useI18n()
  const [all, setAll] = useState(false)
  const sorted = [...rows].sort((a, b) => b.activeMs - a.activeMs)
  const picked = selected ? sorted.filter(r => r.id === selected) : sorted
  if (!picked.length) return null
  const shown = all || selected ? picked : picked.slice(0, EFFORT_ROWS)
  const max = Math.max(1, ...sorted.map(r => r.activeMs))

  return (
    <section aria-labelledby="effort-title" className="space-y-2">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div>
          <h3 id="effort-title" className="text-base font-semibold">
            {t("effort.title")}
          </h3>
          <p className="text-xs text-muted-foreground">{t("effort.note", { n: EFFORT_DAYS })}</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => download(`opencode-sessions-last-${EFFORT_DAYS}-days.csv`, sessionsCsv(sorted))}>
          <DownloadIcon aria-hidden />
          {t("csv.sessions")}
        </Button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th scope="col" className="py-1.5 pr-3 font-normal">{t("effort.session")}</th>
              <th scope="col" className="py-1.5 pr-3 font-normal">{t("effort.active")}</th>
              <th scope="col" className="py-1.5 pr-3 text-right font-normal">{t("effort.wait")}</th>
              <th scope="col" className="py-1.5 pr-3 text-right font-normal">{t("effort.compactions")}</th>
              <th scope="col" className="py-1.5 text-right font-normal">{t("effort.tokens")}</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {shown.map(r => (
              <tr key={r.id} className={cn(r.id === selected && "bg-muted/50")}>
                <th scope="row" className="max-w-0 py-2 pr-3 text-left font-normal sm:w-2/5">
                  <button
                    type="button"
                    onClick={() => onSelect(r.id === selected ? null : r.id)}
                    aria-pressed={r.id === selected}
                    className="block w-full truncate rounded-sm text-left outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                    title={r.title}
                  >
                    {r.title || r.id}
                  </button>
                  <span className="block truncate font-mono text-xs text-muted-foreground">{r.project}</span>
                </th>
                <td className="py-2 pr-3 whitespace-nowrap">
                  <span className="flex items-center gap-2 tabular-nums">
                    <span className="hidden h-1.5 w-16 rounded-full bg-muted sm:block" aria-hidden>
                      <span className="block h-full rounded-full bg-working/70" style={{ width: `${(r.activeMs / max) * 100}%` }} />
                    </span>
                    {rough(r.activeMs)}
                  </span>
                </td>
                <td className={cn("py-2 pr-3 text-right tabular-nums whitespace-nowrap", r.waitMs > 0 ? "text-waiting" : "text-muted-foreground")}>{r.waitMs ? duration(r.waitMs) : "–"}</td>
                <td className={cn("py-2 pr-3 text-right tabular-nums", r.compactions >= 3 ? "text-stuck" : "text-muted-foreground")}>{r.compactions || "–"}</td>
                <td className="py-2 text-right tabular-nums text-muted-foreground">{r.tokens ? compact(r.tokens) : "–"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!selected && !all && picked.length > EFFORT_ROWS && (
        <button type="button" onClick={() => setAll(true)} className="rounded-sm text-sm text-muted-foreground underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring">
          {t("stats.showAll", { n: picked.length - EFFORT_ROWS })}
        </button>
      )}
    </section>
  )
}

/** @param count  number of recorded entries, from the live snapshot: a change means "fetch again" */
export function History({ count, active, session, onSession }: { count: number | null; active: boolean; session: string | null; onSession: (id: string | null) => void }) {
  const { t, lang } = useI18n()
  const [onlyAttention, setOnlyAttention] = useState(false)
  const { events, more, truncated, loading, loadOlder } = useHistory(count, active, session, onlyAttention)
  const sessions = useHistorySessions(count, active)
  // What each session cost, from OpenCode's own records: not limited to when the monitor ran.
  const { stats } = useStats(EFFORT_DAYS, null, null, active)

  const days = useMemo(() => {
    const day = new Intl.DateTimeFormat(lang, { weekday: "long", day: "numeric", month: "long", year: "numeric" })
    const groups: { label: string; events: HistoryEvent[] }[] = []
    for (const e of events) {
      const label = day.format(e.t)
      if (groups.at(-1)?.label !== label) groups.push({ label, events: [] })
      groups.at(-1)!.events.push(e)
    }
    return groups
  }, [events, lang])

  const time = new Intl.DateTimeFormat(lang, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
        <SessionFilter value={session} onChange={onSession} sessions={sessions} current={session && !sessions.some(s => s.id === session) ? { id: session, title: "", project: "" } : null} />
        <div className="flex items-center gap-2.5">
          <Switch id="only-attention" checked={onlyAttention} onCheckedChange={setOnlyAttention} />
          <Label htmlFor="only-attention" className="font-normal text-muted-foreground">
            {t("history.filter")}
          </Label>
        </div>
      </div>

      {stats && <Effort rows={stats.sessions} selected={session} onSelect={onSession} />}

      {!days.length && !loading && (
        <div className="rounded-xl border border-dashed px-6 py-14 text-center">
          <p className="font-medium">{t(session || onlyAttention ? "history.emptyFiltered" : "history.empty")}</p>
          {!session && !onlyAttention && <p className="mt-1 text-sm text-muted-foreground">{t("history.emptyBody")}</p>}
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
                      <span className="ml-auto font-mono text-code text-muted-foreground">{e.project}</span>
                    </div>
                    <p className="text-sm">{why}</p>
                    <p className="text-xs text-muted-foreground">{before}</p>
                    {e.detail && e.to !== "finished" && e.to !== "idle" && <Code className="text-muted-foreground">{e.detail}</Code>}
                  </div>
                </li>
              )
            })}
          </ol>
        </section>
      ))}
      {(more > 0 || truncated) && days.length > 0 && (
        <div className="flex flex-col items-center gap-2 pt-2">
          {more > 0 && (
            <Button variant="outline" onClick={loadOlder} disabled={loading}>
              {loading ? t("history.loading") : t("history.older", { n: more })}
            </Button>
          )}
          {more === 0 && truncated && <p className="text-xs text-muted-foreground">{t("history.truncated")}</p>}
        </div>
      )}
    </div>
  )
}
