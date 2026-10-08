"use client"

import { useState } from "react"
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { duration, rough } from "@/lib/format"
import { useI18n } from "@/lib/i18n"
import { useStats } from "@/lib/live"
import type { DayStats, Stats as StatsData } from "@/lib/types"
import { cn } from "@/lib/utils"
import { Code } from "./details"

const RANGES = [7, 14, 30] as const

const hours = (ms: number) => Math.round((ms / 3_600_000) * 10) / 10

export function Stats() {
  const { t } = useI18n()
  const [days, setDays] = useState<number>(14)
  const { stats, failed } = useStats(days, true)

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center gap-3">
        <Select value={String(days)} onValueChange={value => setDays(Number(value))} items={RANGES.map(d => ({ value: String(d), label: t("stats.range", { n: d }) }))}>
          <SelectTrigger size="sm" aria-label={t("stats.rangeLabel")} className="min-w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {RANGES.map(d => (
              <SelectItem key={d} value={String(d)}>
                {t("stats.range", { n: d })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-sm text-muted-foreground">{t("stats.source")}</p>
      </div>

      {failed && !stats && <p className="text-sm text-error">{t("stats.failed")}</p>}
      {!stats && !failed && <Loading />}
      {stats && <Figures stats={stats} />}
    </div>
  )
}

function Figures({ stats }: { stats: StatsData }) {
  const { t } = useI18n()
  const { totals } = stats

  return (
    <>
      <section aria-label={t("stats.summary")} className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-4">
        <Tile label={t("stats.waitTotal")} value={rough(totals.waitMs)} note={t("stats.prompts", { n: totals.prompts })} tone="waiting" />
        <Tile
          label={t("stats.medianAnswer")}
          value={totals.medianAnswerMs == null ? "–" : duration(totals.medianAnswerMs)}
          note={totals.open ? t("stats.openNow", { n: totals.open }) : t("stats.noneOpen")}
        />
        <Tile label={t("stats.stuck")} value={String(totals.stuck)} note={t("stats.stuckNote", { limit: rough(stats.stuckMs) })} tone={totals.stuck ? "stuck" : undefined} />
        <Tile label={t("stats.agentTime")} value={rough(totals.activeMs)} note={t("stats.sessions", { n: totals.sessions })} />
      </section>

      <div className="grid gap-8 lg:grid-cols-2">
        <DayChart title={t("stats.chartWait")} days={stats.daily} pick={d => d.waitMs} color="var(--color-waiting)" />
        <DayChart title={t("stats.chartActive")} days={stats.daily} pick={d => d.activeMs} color="var(--color-working)" />
      </div>

      <div className="grid gap-8 lg:grid-cols-2">
        <Ranked title={t("stats.longestWaits")} empty={t("stats.noWaits")}>
          {stats.waits.map((w, i) => (
            <li key={`${w.at}-${i}`} className="space-y-1 py-2.5">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                <span className="font-medium tabular-nums text-waiting">{duration(w.waitMs)}</span>
                <span className="text-sm">{w.kind === "question" ? t("stats.question") : t("stats.permission", { permission: w.permission ?? "" })}</span>
                {!w.answered && <span className="text-xs text-muted-foreground">{t(w.abandoned ? "stats.abandoned" : "stats.stillOpen")}</span>}
                <When at={w.at} project={w.project} />
              </div>
              {w.detail && <Code className="text-[0.78rem] text-muted-foreground">{w.detail}</Code>}
            </li>
          ))}
        </Ranked>

        <Ranked title={t("stats.slowest")} note={t("stats.slowestNote")} empty={t("stats.noSlow")}>
          {stats.slow.map((s, i) => (
            <li key={`${s.at}-${i}`} className="space-y-1 py-2.5">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                <span className={cn("font-medium tabular-nums", s.runMs > stats.stuckMs && "text-stuck")}>{duration(s.runMs)}</span>
                <span className="text-sm">{s.tool}</span>
                {s.running && <span className="text-xs text-muted-foreground">{t("stats.stillRunning")}</span>}
                {s.status === "error" && <span className="text-xs text-error">{t("stats.failedCall")}</span>}
                <When at={s.at} project={s.project} />
              </div>
              {s.text && <Code className="text-[0.78rem] text-muted-foreground">{s.text}</Code>}
            </li>
          ))}
        </Ranked>
      </div>

      <div className="grid gap-8 lg:grid-cols-2">
        <ToolUse stats={stats} />
        <div className="space-y-8">
          <Ranked title={t("stats.rereads")} note={t("stats.rereadsNote")} empty={t("stats.noRereads")}>
            {stats.rereads.map(r => (
              <li key={`${r.file}-${r.project}`} className="flex items-baseline gap-3 py-2">
                <span className="w-8 shrink-0 text-right font-medium tabular-nums">×{r.count}</span>
                <Code className="min-w-0 text-[0.78rem]">{r.file}</Code>
              </li>
            ))}
          </Ranked>
          <Ranked title={t("stats.skills")} empty={t("stats.noSkills")}>
            {stats.skills.map(s => (
              <li key={s.name} className="flex items-baseline gap-3 py-2">
                <span className="w-8 shrink-0 text-right font-medium tabular-nums">×{s.count}</span>
                <span className="text-sm">{s.name}</span>
              </li>
            ))}
          </Ranked>
        </div>
      </div>

      {(totals.abandoned > 0 || totals.abandonedCalls > 0) && (
        <p className="text-sm text-muted-foreground">{t("stats.abandonedNote", { prompts: totals.abandoned, calls: totals.abandonedCalls })}</p>
      )}
    </>
  )
}

function Tile({ label, value, note, tone }: { label: string; value: string; note: string; tone?: "waiting" | "stuck" }) {
  return (
    <div className="space-y-1">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className={cn("text-3xl font-light tracking-tight tabular-nums", tone === "waiting" && "text-waiting", tone === "stuck" && "text-stuck")}>{value}</p>
      <p className="text-xs text-muted-foreground">{note}</p>
    </div>
  )
}

function When({ at, project }: { at: number; project: string }) {
  const { lang } = useI18n()
  const when = new Intl.DateTimeFormat(lang, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(at)
  return (
    <span className="ml-auto text-xs text-muted-foreground">
      {when} <span className="font-mono">{project}</span>
    </span>
  )
}

function Ranked({ title, note, empty, children }: { title: string; note?: string; empty: string; children: React.ReactNode[] }) {
  return (
    <section className="space-y-2">
      <div>
        <h3 className="font-medium">{title}</h3>
        {note && <p className="text-xs text-muted-foreground">{note}</p>}
      </div>
      {children.length ? <ol className="divide-y border-y">{children}</ol> : <p className="text-sm text-muted-foreground">{empty}</p>}
    </section>
  )
}

/** One bar per day, in hours. Single series: the title names it, so there is no legend. */
function DayChart({ title, days, pick, color }: { title: string; days: DayStats[]; pick: (d: DayStats) => number; color: string }) {
  const { t, lang } = useI18n()
  const label = new Intl.DateTimeFormat(lang, { day: "numeric", month: "short" })
  const data = days.map(d => ({ date: d.date, label: label.format(new Date(`${d.date}T12:00:00`)), value: hours(pick(d)), ms: pick(d) }))
  const total = data.reduce((n, d) => n + d.ms, 0)

  return (
    <section className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="font-medium">{title}</h3>
        <span className="text-sm tabular-nums text-muted-foreground">{t("stats.total", { t: rough(total) })}</span>
      </div>
      <div className="h-48" role="img" aria-label={title}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: -18 }} barCategoryGap={data.length > 14 ? 2 : 6}>
            <CartesianGrid vertical={false} stroke="var(--color-border)" strokeDasharray="0" />
            <XAxis dataKey="label" tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={16} tick={{ fill: "var(--color-muted-foreground)", fontSize: 11 }} />
            <YAxis tickLine={false} axisLine={false} width={44} allowDecimals={false} tick={{ fill: "var(--color-muted-foreground)", fontSize: 11 }} tickFormatter={v => `${v}h`} />
            <Tooltip
              cursor={{ fill: "var(--color-muted)", opacity: 0.6 }}
              content={({ active, payload }) => {
                const item = payload?.[0]?.payload as (typeof data)[number] | undefined
                if (!active || !item) return null
                return (
                  <div className="rounded-lg border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md">
                    <p className="text-muted-foreground">{item.label}</p>
                    <p className="font-medium tabular-nums">{item.ms ? duration(item.ms) : "0"}</p>
                  </div>
                )
              }}
            />
            <Bar dataKey="value" fill={color} radius={[4, 4, 0, 0]} maxBarSize={28} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <NumbersTable rows={data.map(d => [d.label, d.ms ? duration(d.ms) : "0"])} />
    </section>
  )
}

/** The same figures as text, for screen readers and for reading exact values. */
function NumbersTable({ rows }: { rows: [string, string][] }) {
  const { t } = useI18n()
  return (
    <Collapsible>
      <CollapsibleTrigger className="text-xs text-muted-foreground underline-offset-4 hover:underline focus-visible:underline focus-visible:outline-none">{t("stats.showNumbers")}</CollapsibleTrigger>
      <CollapsibleContent>
        <table className="mt-2 w-full text-xs">
          <tbody className="divide-y">
            {rows.map(([day, value]) => (
              <tr key={day}>
                <th scope="row" className="py-1 text-left font-normal text-muted-foreground">
                  {day}
                </th>
                <td className="py-1 text-right tabular-nums">{value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </CollapsibleContent>
    </Collapsible>
  )
}

/** Calls per tool as a bar list; errors are named in the row, not encoded by colour alone. */
function ToolUse({ stats }: { stats: StatsData }) {
  const { t } = useI18n()
  const max = Math.max(1, ...stats.tools.map(x => x.count))
  const { graft, other } = stats.explore
  return (
    <section className="space-y-3">
      <div>
        <h3 className="font-medium">{t("stats.tools")}</h3>
        <p className="text-xs text-muted-foreground">{t("stats.toolsNote", { calls: stats.totals.toolCalls, errors: stats.totals.toolErrors })}</p>
      </div>
      <ul className="space-y-1.5">
        {stats.tools.map(x => (
          <li key={x.tool} className="grid grid-cols-[minmax(6rem,11rem)_1fr_auto] items-center gap-3 text-[0.82rem]">
            <span className="truncate font-mono text-[0.78rem]" title={x.tool}>
              {x.tool}
            </span>
            <span className="h-2 rounded-full bg-muted" aria-hidden>
              <span className="block h-full rounded-full bg-working/70" style={{ width: `${(x.count / max) * 100}%` }} />
            </span>
            <span className="tabular-nums text-muted-foreground">
              {x.count}
              {x.errors > 0 && <span className="text-error"> · {t("stats.errors", { n: x.errors })}</span>}
            </span>
          </li>
        ))}
      </ul>
      {graft + other > 0 && <p className="text-sm text-muted-foreground">{t("stats.graftShare", { graft, other, pct: Math.round((graft / (graft + other)) * 100) })}</p>}
    </section>
  )
}

function Loading() {
  return (
    <div className="space-y-6" aria-hidden>
      <div className="grid grid-cols-2 gap-6 sm:grid-cols-4">
        {[0, 1, 2, 3].map(i => (
          <Skeleton key={i} className="h-20" />
        ))}
      </div>
      <Skeleton className="h-56 w-full" />
    </div>
  )
}
