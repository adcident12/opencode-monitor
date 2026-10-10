"use client"

import { useState } from "react"
import { Area, AreaChart, Bar, BarChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import { DownloadIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { dailyCsv, download } from "@/lib/csv"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { compact, duration, money, quick, rough } from "@/lib/format"
import { useI18n } from "@/lib/i18n"
import { useStats } from "@/lib/live"
import type { DayStats, McpStat, PeriodSummary, Stats as StatsData } from "@/lib/types"
import { cn } from "@/lib/utils"
import { Code } from "./details"
import { Chapter, H3, TAB, TH } from "./section"
import { Agents, Files, Permissions, Plans, TimeSplit, Turns } from "./work"
import { SessionFilter } from "./session-filter"

const RANGES = [7, 14, 30] as const
// A ranked row: the figure, what it was, and when and where, each in its own column so nothing wraps under another.
// On a phone the third column has no room, so when and where go under the label instead.
const ROW = "grid grid-cols-[3.75rem_minmax(0,1fr)] items-baseline gap-x-3 gap-y-0.5 sm:grid-cols-[3.75rem_minmax(0,1fr)_auto]"

const hours = (ms: number) => Math.round((ms / 3_600_000) * 10) / 10

/** @param session  the one session to count, kept in the URL so a card can link straight here */
export function Stats({ session, onSession }: { session: string | null; onSession: (id: string | null) => void }) {
  const { t } = useI18n()
  const [days, setDays] = useState<number>(14)
  // A day inside the period: what was changed that day is judged by the days on either side.
  const [split, setSplit] = useState<string | null>(null)
  const { stats, failed } = useStats(days, session, split, true)
  // The list comes with the figures; keep the last one so the filter does not empty while loading.
  const [choices, setChoices] = useState<StatsData["sessions"]>([])
  if (stats && stats.sessions !== choices) setChoices(stats.sessions)

  return (
    <div className={TAB}>
      <div className="space-y-2.5">
        <div className="flex flex-wrap items-center gap-2.5">
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
        <SessionFilter value={session} onChange={onSession} sessions={choices} current={stats?.session} />
          <SplitPicker value={split} onChange={setSplit} days={days} />
          <Button
            variant="outline"
            size="sm"
            className="sm:ml-auto"
            disabled={!stats}
            onClick={() => stats && download(`opencode-days-${stats.daily[0]?.date ?? ""}-${stats.daily.at(-1)?.date ?? ""}${stats.session ? `-${stats.session.id}` : ""}.csv`, dailyCsv(stats.daily))}
          >
            <DownloadIcon aria-hidden />
            {t("csv.days")}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">{t(session ? "stats.sourceSession" : "stats.source")}</p>
      </div>

      {failed && !stats && <p className="text-sm text-error">{t("stats.failed")}</p>}
      {!stats && !failed && <Loading />}
      {stats?.compare && <Compare compare={stats.compare} />}
      {stats && split && !stats.compare && <p className="text-sm text-muted-foreground">{t("compare.none")}</p>}
      {stats && <Figures stats={stats} />}
    </div>
  )
}

const NO_SPLIT = "none"

/** Local calendar day, as the server names its day buckets. */
const dayOf = (t: number) => {
  const d = new Date(t)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

/** Picks the day a setting was changed. The first day of the period would leave nothing before it. */
function SplitPicker({ value, onChange, days }: { value: string | null; onChange: (day: string | null) => void; days: number }) {
  const { t, lang } = useI18n()
  const label = new Intl.DateTimeFormat(lang, { weekday: "short", day: "numeric", month: "short" })
  // Lazy initial state: the list of days is fixed when the picker appears, and reading the clock during render is not pure.
  const [today] = useState(() => new Date().setHours(12, 0, 0, 0))
  const choices = Array.from({ length: days - 1 }, (_, i) => today - i * 86_400_000).map(at => ({ value: dayOf(at), label: t("compare.from", { day: label.format(at) }) }))
  const items = [{ value: NO_SPLIT, label: t("compare.off") }, ...choices]

  return (
    <Select value={value ?? NO_SPLIT} onValueChange={next => onChange(!next || next === NO_SPLIT ? null : String(next))} items={items}>
      <SelectTrigger size="sm" aria-label={t("compare.label")} className="min-w-40">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {items.map(item => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

type Metric = { key: keyof PeriodSummary; better: "lower" | "higher" | null; show: (n: number) => string }

/**
 * The days before a chosen day beside the days from it on. Rates and typical values only,
 * and each change is said in words as well as coloured, because "up" is good for some rows
 * and bad for others.
 */
function Compare({ compare }: { compare: NonNullable<StatsData["compare"]> }) {
  const { t, lang } = useI18n()
  const { before, after } = compare
  const day = new Intl.DateTimeFormat(lang, { day: "numeric", month: "long" }).format(new Date(`${compare.split}T12:00:00`))
  const pct = (n: number) => `${n}%`
  const each = (n: number) => String(n)
  const metrics: Metric[] = [
    { key: "startTokens", better: "lower", show: compact },
    { key: "compactionsPerSession", better: "lower", show: each },
    { key: "rereadsPerSession", better: "lower", show: each },
    { key: "toolErrorPct", better: "lower", show: pct },
    { key: "mcpNoAnswerPct", better: "lower", show: pct },
    { key: "cachedPct", better: "higher", show: pct },
    { key: "costPerSession", better: "lower", show: money },
    { key: "writeTps", better: "higher", show: n => t("stats.speedTps", { n: n < 100 ? n.toFixed(1) : Math.round(n) }) },
    { key: "firstTokenMs", better: "lower", show: quick },
    { key: "toolCallsPerSession", better: null, show: each },
    { key: "medianAnswerMs", better: null, show: duration },
  ]
  const thin = Math.min(before.sessions, after.sessions) < 3

  return (
    <section aria-label={t("compare.title")} className="space-y-3 rounded-xl border bg-card px-4 py-4 sm:px-5">
      <div>
        <h3 className={H3}>{t("compare.heading", { day })}</h3>
        <p className="text-xs text-muted-foreground">{t("compare.note")}</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b">
              <th scope="col" className={TH} />
              <th scope="col" className={cn(TH, "text-right")}>{t("compare.before", { days: before.days, sessions: before.sessions })}</th>
              <th scope="col" className={cn(TH, "text-right")}>{t("compare.after", { days: after.days, sessions: after.sessions })}</th>
              <th scope="col" className={cn(TH, "text-right")}>{t("compare.change")}</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {metrics.map(m => {
              const a = before[m.key]
              const b = after[m.key]
              if (a == null && b == null) return null
              return (
                <tr key={m.key}>
                  <th scope="row" className="py-2 pr-3 text-left font-normal">
                    {t(`compare.metric.${m.key}`)}
                    {(m.key === "writeTps" || m.key === "firstTokenMs") && compare.model && <span className="block font-mono text-xs text-muted-foreground">{compare.model}</span>}
                  </th>
                  <td className="py-2 pr-3 text-right tabular-nums whitespace-nowrap text-muted-foreground">{a == null ? "–" : m.show(a)}</td>
                  <td className="py-2 pr-3 text-right font-medium tabular-nums whitespace-nowrap">{b == null ? "–" : m.show(b)}</td>
                  <td className="py-2 text-right whitespace-nowrap">
                    <Change before={a} after={b} better={m.better} />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {thin && <p className="text-xs text-waiting">{t("compare.thin")}</p>}
    </section>
  )
}

function Change({ before, after, better }: { before: number | null; after: number | null; better: Metric["better"] }) {
  const { t } = useI18n()
  if (before == null || after == null) return <span className="text-muted-foreground">–</span>
  if (before === after) return <span className="text-muted-foreground">{t("compare.same")}</span>
  const up = after > before
  // From zero there is no percentage to give.
  const size = before === 0 ? "" : ` ${Math.round((Math.abs(after - before) / Math.abs(before)) * 100)}%`
  const verdict = better == null ? null : (better === "higher") === up ? "better" : "worse"
  return (
    <span className={cn("tabular-nums", verdict === "better" && "text-working", verdict === "worse" && "text-error", !verdict && "text-muted-foreground")}>
      {up ? "↑" : "↓"}
      {size}
      {verdict && <span className="ml-1.5 text-xs">{t(`compare.${verdict}`)}</span>}
    </span>
  )
}

/** The chapters of the page, in reading order. Each id is also where the jump links land. */
const GROUPS = ["you", "agent", "done", "model", "mcp"] as const
type GroupId = (typeof GROUPS)[number]

/**
 * A chapter: a real heading, a rule above it, and room. Without these the page was one long
 * run of equally weighted lists, and finding "how fast is the model" meant reading all of it.
 */
function Group({ id, note, children }: { id: GroupId; note?: string; children: React.ReactNode }) {
  const { t } = useI18n()
  return (
    <Chapter id={`stats-${id}`} title={t(`stats.group.${id}`)} note={note}>
      {children}
    </Chapter>
  )
}

/** Links to the chapters. Plain scrolling: the URL hash already says which tab is open. */
function Jump({ shown }: { shown: GroupId[] }) {
  const { t } = useI18n()
  const go = (id: GroupId) => {
    const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    document.getElementById(`stats-${id}`)?.scrollIntoView({ behavior: calm ? "auto" : "smooth", block: "start" })
  }
  return (
    <nav aria-label={t("stats.jump")} className="-mx-2 flex flex-wrap items-center gap-x-1 gap-y-1 text-sm">
      <span className="px-2 text-muted-foreground">{t("stats.jump")}</span>
      {shown.map(id => (
        <button key={id} type="button" onClick={() => go(id)} className="rounded-md px-2 py-1 text-foreground/80 outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
          {t(`stats.group.${id}`)}
        </button>
      ))}
    </nav>
  )
}

function Figures({ stats }: { stats: StatsData }) {
  const { t } = useI18n()
  const { totals } = stats
  const hasModel = stats.usage.requests > 0 || stats.speed.models.length > 0 || stats.context != null
  const hasDone = stats.work.files.edits > 0 || stats.work.plans.total > 0
  const shown = GROUPS.filter(id => (id === "model" ? hasModel : id === "mcp" ? stats.mcp.length > 0 : id === "done" ? hasDone : true))

  return (
    <>
      <section aria-label={t("stats.summary")} className="grid grid-cols-2 gap-x-6 gap-y-6 sm:grid-cols-4">
        <Tile label={t("stats.waitTotal")} value={rough(totals.waitMs)} note={t("stats.prompts", { n: totals.prompts })} tone="waiting" />
        <Tile
          label={t("stats.medianAnswer")}
          value={totals.medianAnswerMs == null ? "–" : duration(totals.medianAnswerMs)}
          note={totals.open ? t("stats.openNow", { n: totals.open }) : t("stats.noneOpen")}
        />
        <Tile label={t("stats.stuck")} value={String(totals.stuck)} note={t("stats.stuckNote", { limit: rough(stats.stuckMs) })} tone={totals.stuck ? "stuck" : undefined} />
        <Tile label={t("stats.agentTime")} value={rough(totals.activeMs)} note={t("stats.sessions", { n: totals.sessions })} />
      </section>

      <Jump shown={shown} />

      <Group id="you">
        <div className="grid grid-cols-[minmax(0,1fr)] gap-x-10 gap-y-8 lg:grid-cols-2">
          <DayChart title={t("stats.chartWait")} days={stats.daily} pick={d => d.waitMs} color="var(--color-waiting)" />
          <Ranked title={t("stats.longestWaits")} empty={t("stats.noWaits")}>
            {stats.waits.map((w, i) => (
              <li key={`${w.at}-${i}`} className="space-y-1 py-2.5">
                <div className={ROW}>
                  <span className="font-medium tabular-nums text-waiting">{duration(w.waitMs)}</span>
                  <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                    <span className="text-sm">{w.kind === "question" ? t("stats.question") : t("stats.permission", { permission: w.permission ?? "" })}</span>
                    {!w.answered && <span className="text-xs text-muted-foreground">{t(w.abandoned ? "stats.abandoned" : "stats.stillOpen")}</span>}
                  </span>
                  <When at={w.at} project={w.project} />
                </div>
                {w.detail && <Code className="pl-[4.5rem] text-muted-foreground">{w.detail}</Code>}
              </li>
            ))}
          </Ranked>
        </div>
        <Permissions work={stats.work} />
      </Group>

      <Group id="agent">
        <TimeSplit work={stats.work} />
        <div className="grid grid-cols-[minmax(0,1fr)] gap-x-10 gap-y-8 lg:grid-cols-2">
          <Turns work={stats.work} />
          <Agents work={stats.work} />
        </div>
        <div className="grid grid-cols-[minmax(0,1fr)] gap-x-10 gap-y-8 lg:grid-cols-2">
          <DayChart title={t("stats.chartActive")} days={stats.daily} pick={d => d.activeMs} color="var(--color-working)" />
          <Ranked title={t("stats.slowest")} note={t("stats.slowestNote")} empty={t("stats.noSlow")}>
            {stats.slow.map((s, i) => (
              <li key={`${s.at}-${i}`} className="space-y-1 py-2.5">
                <div className={ROW}>
                  <span className={cn("font-medium tabular-nums", s.runMs > stats.stuckMs && "text-stuck")}>{duration(s.runMs)}</span>
                  <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                    <span className="text-sm [overflow-wrap:anywhere]">{s.tool}</span>
                    {s.running && <span className="text-xs text-muted-foreground">{t("stats.stillRunning")}</span>}
                    {s.status === "error" && <span className="text-xs text-error">{t("stats.failedCall")}</span>}
                  </span>
                  <When at={s.at} project={s.project} />
                </div>
                {s.text && <Code className="pl-[4.5rem] text-muted-foreground">{s.text}</Code>}
              </li>
            ))}
          </Ranked>
        </div>

        <div className="grid grid-cols-[minmax(0,1fr)] gap-x-10 gap-y-8 lg:grid-cols-2">
          <ToolUse stats={stats} />
          <div className="space-y-8">
            <Ranked title={t("stats.rereads")} note={t("stats.rereadsNote")} empty={t("stats.noRereads")} shortBy={10}>
              {stats.rereads.map(r => (
                <li key={`${r.file}-${r.project}`} className="flex items-baseline gap-3 py-2">
                  <span className="w-9 shrink-0 font-medium tabular-nums">×{r.count}</span>
                  <Code className="min-w-0">{r.file}</Code>
                </li>
              ))}
            </Ranked>
            <Ranked title={t("stats.skills")} empty={t("stats.noSkills")}>
              {stats.skills.map(s => (
                <li key={s.name} className="flex items-baseline gap-3 py-2">
                  <span className="w-9 shrink-0 font-medium tabular-nums">×{s.count}</span>
                  <span className="text-sm">{s.name}</span>
                </li>
              ))}
            </Ranked>
          </div>
        </div>

        {(totals.abandoned > 0 || totals.abandonedCalls > 0) && (
          <p className="max-w-prose text-sm text-muted-foreground">{t("stats.abandonedNote", { prompts: totals.abandoned, calls: totals.abandonedCalls })}</p>
        )}
      </Group>

      {hasDone && (
        <Group id="done">
          <div className="grid grid-cols-[minmax(0,1fr)] gap-x-10 gap-y-8 lg:grid-cols-2">
            <Files work={stats.work} />
            <Plans work={stats.work} />
          </div>
        </Group>
      )}

      {hasModel && (
        <Group id="model">
          <Context stats={stats} />
          {totals.serverLimitCompactions > 0 && <p className="max-w-prose rounded-lg bg-stuck-soft/60 px-3 py-2 text-sm text-stuck">{t("hint.server_limit", { n: totals.serverLimitCompactions })}</p>}
          <Speed stats={stats} />
          <Usage stats={stats} />
        </Group>
      )}

      {stats.mcp.length > 0 && (
        <Group id="mcp" note={t("stats.mcpNote")}>
          <McpServers stats={stats} />
        </Group>
      )}
    </>
  )
}

function Tile({ label, value, note, tone }: { label: string; value: string; note: string; tone?: "waiting" | "stuck" }) {
  return (
    <div className="space-y-1">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className={cn("text-3xl font-light tabular-nums", tone === "waiting" && "text-waiting", tone === "stuck" && "text-stuck")}>{value}</p>
      <p className="text-xs text-muted-foreground">{note}</p>
    </div>
  )
}

function When({ at, project }: { at: number; project: string }) {
  const { lang } = useI18n()
  const when = new Intl.DateTimeFormat(lang, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(at)
  return (
    <span className="col-start-2 flex max-w-[16rem] min-w-0 items-baseline gap-1.5 text-xs whitespace-nowrap text-muted-foreground sm:col-start-auto">
      {when}
      <span className="truncate font-mono" title={project}>
        {project}
      </span>
    </span>
  )
}

/** @param shortBy  show only this many until asked for the rest */
function Ranked({ title, note, empty, shortBy, children }: { title: string; note?: string; empty: string; shortBy?: number; children: React.ReactNode[] }) {
  const { t } = useI18n()
  const [all, setAll] = useState(false)
  const hidden = shortBy && !all ? Math.max(0, children.length - shortBy) : 0
  const shown = hidden ? children.slice(0, shortBy) : children
  return (
    <section className="space-y-2">
      <div>
        <h3 className={H3}>{title}</h3>
        {note && <p className="mt-0.5 text-xs text-muted-foreground">{note}</p>}
      </div>
      {children.length ? <ol className="divide-y border-y">{shown}</ol> : <p className="text-sm text-muted-foreground">{empty}</p>}
      {hidden > 0 && (
        <button type="button" onClick={() => setAll(true)} className="rounded-sm text-sm text-muted-foreground underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring">
          {t("stats.showAll", { n: hidden })}
        </button>
      )}
    </section>
  )
}

/** One bar per day, in hours. */
function DayChart({ title, days, pick, color }: { title: string; days: DayStats[]; pick: (d: DayStats) => number; color: string }) {
  const { t } = useI18n()
  const total = days.reduce((n, d) => n + pick(d), 0)
  const points = days.map(d => ({ date: d.date, value: hours(pick(d)), text: pick(d) ? duration(pick(d)) : "0" }))
  return <Bars title={title} summary={t("stats.total", { t: rough(total) })} points={points} color={color} tick={v => `${v}h`} />
}

/** One bar per day. Single series: the title names it, so there is no legend. */
function Bars({ title, summary, points, color, tick }: { title: string; summary: string; points: { date: string; value: number; text: string }[]; color: string; tick: (v: number) => string }) {
  const { lang } = useI18n()
  const label = new Intl.DateTimeFormat(lang, { day: "numeric", month: "short" })
  const data = points.map(p => ({ ...p, label: label.format(new Date(`${p.date}T12:00:00`)) }))

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <h3 className={cn(H3, "min-w-0 [overflow-wrap:anywhere]")}>{title}</h3>
        <span className="text-sm tabular-nums text-muted-foreground">{summary}</span>
      </div>
      <div className="h-48" role="img" aria-label={title}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: -18 }} barCategoryGap={data.length > 14 ? 2 : 6}>
            <CartesianGrid vertical={false} stroke="var(--color-border)" strokeDasharray="0" />
            <XAxis dataKey="label" tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={16} tick={{ fill: "var(--color-muted-foreground)", fontSize: 12 }} />
            <YAxis tickLine={false} axisLine={false} width={44} allowDecimals={false} tick={{ fill: "var(--color-muted-foreground)", fontSize: 12 }} tickFormatter={tick} />
            <Tooltip
              cursor={{ fill: "var(--color-muted)", opacity: 0.6 }}
              content={({ active, payload }) => {
                const item = payload?.[0]?.payload as (typeof data)[number] | undefined
                if (!active || !item) return null
                return (
                  <div className="rounded-lg border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md">
                    <p className="text-muted-foreground">{item.label}</p>
                    <p className="font-medium tabular-nums">{item.text}</p>
                  </div>
                )
              }}
            />
            <Bar dataKey="value" fill={color} radius={[4, 4, 0, 0]} maxBarSize={28} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <NumbersTable rows={data.map(d => [d.label, d.text])} />
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
  // Only for people who have graft: to anyone else "graft was used for 0%" means nothing.
  const hasGraft = graft > 0 || stats.mcp.some(m => m.name === "graft" && m.enabled)
  return (
    <section className="space-y-3">
      <div>
        <h3 className={H3}>{t("stats.tools")}</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">{t("stats.toolsNote", { calls: stats.totals.toolCalls, errors: stats.totals.toolErrors })}</p>
      </div>
      <ul className="space-y-1.5">
        {stats.tools.map(x => (
          <li key={x.tool} className="grid grid-cols-[minmax(6rem,11rem)_1fr_auto] items-center gap-3 text-sm">
            <span className="truncate font-mono text-code" title={x.tool}>
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
      {hasGraft && graft + other > 0 && <p className="text-sm text-muted-foreground">{t("stats.graftShare", { graft, other, pct: Math.round((graft / (graft + other)) * 100) })}</p>}
    </section>
  )
}

/**
 * One session's context window over its requests: how full it got, where it was compacted
 * (dashed lines), and what each compaction cost in files read a second time.
 */
function Context({ stats }: { stats: StatsData }) {
  const { t, lang } = useI18n()
  const context = stats.context
  if (!context || context.points.length < 2) return null
  const time = new Intl.DateTimeFormat(lang, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false })
  const data = context.points.map((p, i) => ({ i, tokens: p.tokens, t: p.t }))
  const peakPct = context.limit ? Math.round((context.peak / context.limit) * 100) : null

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div>
          <h3 className={H3}>{t("stats.context")}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t("stats.contextNote", { n: context.requests })}
            {context.compactAt != null && <> {t("stats.contextCompactAt", { n: compact(context.compactAt) })}</>}
          </p>
        </div>
        <span className="text-sm tabular-nums text-muted-foreground">
          {peakPct == null ? t("stats.contextPeak", { n: compact(context.peak) }) : t("stats.contextPeakOf", { n: compact(context.peak), limit: compact(context.limit!), pct: peakPct })}
        </span>
      </div>
      <div className="h-52" role="img" aria-label={t("stats.context")}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 6, right: 6, bottom: 0, left: -8 }}>
            <CartesianGrid vertical={false} stroke="var(--color-border)" />
            <XAxis dataKey="i" type="number" domain={[0, data.length - 1]} tickLine={false} axisLine={false} tick={false} height={6} />
            <YAxis tickLine={false} axisLine={false} width={52} domain={[0, context.limit ?? "auto"]} tick={{ fill: "var(--color-muted-foreground)", fontSize: 12 }} tickFormatter={v => compact(Number(v))} />
            <Tooltip
              cursor={{ stroke: "var(--color-muted-foreground)", strokeOpacity: 0.4 }}
              content={({ active, payload }) => {
                const item = payload?.[0]?.payload as (typeof data)[number] | undefined
                if (!active || !item) return null
                return (
                  <div className="rounded-lg border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md">
                    <p className="text-muted-foreground">{time.format(item.t)}</p>
                    <p className="font-medium tabular-nums">{t("stats.contextTokens", { n: compact(item.tokens) })}</p>
                  </div>
                )
              }}
            />
            {context.compactAt != null && <ReferenceLine y={context.compactAt} stroke="var(--color-stuck)" strokeOpacity={0.7} strokeDasharray="2 4" />}
            {context.compactions.map(c => c.at != null && <ReferenceLine key={c.t} x={c.at} stroke="var(--color-waiting)" strokeDasharray="4 3" />)}
            <Area dataKey="tokens" type="stepAfter" stroke="var(--color-working)" fill="var(--color-working)" fillOpacity={0.18} strokeWidth={1.5} isAnimationActive={false} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      {context.compactions.length > 0 ? (
        <ol className="divide-y border-y text-sm">
          {context.compactions.map(c => (
            <li key={c.t} className="flex flex-wrap items-baseline gap-x-4 gap-y-0.5 py-2">
              <span className="text-xs text-muted-foreground">{time.format(c.t)}</span>
              <span className="tabular-nums">{c.before != null && c.after != null ? t("stats.contextCompacted", { before: compact(c.before), after: compact(c.after) }) : t("stats.contextCompactedPlain")}</span>
              <span className={cn("tabular-nums", c.reread > 0 ? "text-waiting" : "text-muted-foreground")}>{t("stats.contextReread", { n: c.reread })}</span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-sm text-muted-foreground">{t("stats.contextNoCompaction")}</p>
      )}
    </section>
  )
}

/**
 * How fast each model answers. Writing and reading are kept apart: a slow first token is a
 * long or uncached prompt, slow writing is the server itself.
 */
function Speed({ stats }: { stats: StatsData }) {
  const { t } = useI18n()
  const models = stats.speed.models.filter(m => m.writeTps != null || m.readTps != null)
  if (!models.length) return null
  const main = models[0]
  const tps = (n: number | null) => (n == null ? "–" : t("stats.speedTps", { n: n < 100 ? n.toFixed(1) : Math.round(n) }))
  const points = stats.daily.map((d, i) => ({ date: d.date, value: main.daily[i] ?? 0, text: tps(main.daily[i] ?? null) }))

  return (
    <section className="space-y-4">
      <div>
        <h3 className={H3}>{t("stats.speed")}</h3>
        <p className="mt-0.5 max-w-prose text-xs text-muted-foreground">{t("stats.speedNote")}</p>
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-8 lg:grid-cols-2">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b">
                <th scope="col" className={TH}>{t("stats.speedModel")}</th>
                <th scope="col" className={cn(TH, "text-right")}>{t("stats.speedWrite")}</th>
                <th scope="col" className={cn(TH, "text-right")}>{t("stats.speedRead")}</th>
                <th scope="col" className={cn(TH, "text-right")}>{t("stats.speedFirst")}</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {models.map(m => (
                <tr key={m.model}>
                  <th scope="row" className="py-2 pr-3 text-left font-normal">
                    <span className="font-mono text-code [overflow-wrap:anywhere]">{m.model}</span>
                    <span className="block text-xs text-muted-foreground">{t("stats.speedRequests", { n: m.requests })}</span>
                  </th>
                  <td className="py-2 pr-3 text-right font-medium tabular-nums whitespace-nowrap">{tps(m.writeTps)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums whitespace-nowrap text-muted-foreground">{tps(m.readTps)}</td>
                  <td className="py-2 text-right tabular-nums whitespace-nowrap text-muted-foreground">{m.firstTokenMs == null ? "–" : quick(m.firstTokenMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Bars title={t("stats.speedChart", { model: main.model })} summary={tps(main.writeTps)} points={points} color="var(--color-working)" tick={v => String(v)} />
      </div>
    </section>
  )
}

/** What the model was sent and what it wrote, and how big a session is before it starts. */
function Usage({ stats }: { stats: StatsData }) {
  const { t } = useI18n()
  const { usage } = stats
  if (!usage.requests) return null
  const sent = usage.input + usage.cacheRead + usage.cacheWrite
  return (
    <section className="space-y-4">
      <div>
        <h3 className={H3}>{t("stats.usage")}</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">{t("stats.usageNote", { n: usage.requests })}</p>
      </div>
      <div className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-4">
        <Tile label={t("stats.usageSent")} value={compact(sent)} note={usage.cachedPct == null ? "" : t("stats.usageCached", { pct: usage.cachedPct })} />
        <Tile label={t("stats.usageNew")} value={compact(usage.input + usage.cacheWrite)} note={t("stats.usageNewNote")} />
        <Tile label={t("stats.usageOutput")} value={compact(usage.output)} note={usage.reasoning ? t("stats.usageReasoning", { n: compact(usage.reasoning) }) : ""} />
        {usage.cost > 0 ? (
          <Tile label={t("stats.usageCost")} value={money(usage.cost)} note={t("stats.usageCostNote")} />
        ) : (
          usage.start && <Tile label={t("stats.usageStart")} value={compact(usage.start.median)} note={t("stats.usageStartRange", { min: compact(usage.start.min), max: compact(usage.start.max), n: usage.start.sessions })} />
        )}
      </div>
      {usage.cost > 0 && (
        <Bars
          title={t("stats.costChart")}
          summary={money(usage.cost)}
          points={stats.daily.map(d => ({ date: d.date, value: Math.round(d.cost * 100) / 100, text: money(d.cost) }))}
          color="var(--color-working)"
          tick={v => `$${v}`}
        />
      )}
      {usage.start && (
        <p className="max-w-prose text-sm text-muted-foreground">
          {usage.cost > 0 && <>{t("stats.usageStartLine", { median: compact(usage.start.median), n: usage.start.sessions })} </>}
          {t("stats.usageStartNote")}
        </p>
      )}
    </section>
  )
}

/**
 * One row per MCP server. Failures are split in two on purpose: a tool that reported an
 * error was reached and answered, a server that did not answer is a different problem.
 */
function McpServers({ stats }: { stats: StatsData }) {
  const { t, lang } = useI18n()
  if (!stats.mcp.length) return null
  const when = new Intl.DateTimeFormat(lang, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false })
  const unused = stats.mcp.filter(m => m.unused)
  // A server that is off and has nothing to report does not need a row of zeros.
  const quiet = (m: McpStat) => !m.enabled && !m.calls && !m.disconnects && !m.startFailures
  const rows = stats.mcp.filter(m => !quiet(m))
  const off = stats.mcp.filter(quiet)
  // Failures logged before the oldest log line we have are unknown, not zero.
  const logShort = !stats.session && stats.mcpLogFrom != null && stats.mcpLogFrom > stats.range.from

  return (
    <div className="space-y-3">
      {rows.length > 0 && (
        <ul className="divide-y border-y">
          {rows.map(m => (
            <McpRow key={m.name} server={m} when={when} />
          ))}
        </ul>
      )}
      {off.length > 0 && (
        <p className="text-sm text-muted-foreground">
          {t("stats.mcpOffList")} <span className="font-mono text-code">{off.map(m => m.name).join(", ")}</span>
        </p>
      )}
      {unused.length > 0 && <p className="max-w-prose text-sm text-muted-foreground">{t(stats.session ? "stats.mcpUnusedSession" : "stats.mcpUnused", { names: unused.map(m => m.name).join(", ") })}</p>}
      {stats.session && <p className="text-xs text-muted-foreground">{t("stats.mcpNoLogForSession")}</p>}
      {logShort && <p className="text-xs text-muted-foreground">{t("stats.mcpLogFrom", { t: when.format(stats.mcpLogFrom!) })}</p>}
    </div>
  )
}

function McpRow({ server: m, when }: { server: McpStat; when: Intl.DateTimeFormat }) {
  const { t } = useI18n()
  const summary = (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-4 gap-y-1 py-2.5 text-left sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_auto]">
      <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className={cn("truncate font-mono text-code", !m.enabled && "text-muted-foreground")}>{m.name}</span>
        {!m.enabled && <Tag>{t("stats.mcpOff")}</Tag>}
        {m.scope === "project" && <Tag>{t("stats.mcpProject")}</Tag>}
        {m.unused && <Tag tone="warn">{t("stats.mcpNeverUsed")}</Tag>}
      </span>
      <span className="col-span-2 flex flex-wrap gap-x-3 gap-y-0.5 text-sm tabular-nums sm:col-span-1">
        <span>{t("stats.mcpCalls", { n: m.calls })}</span>
        {m.errors > 0 && <span className="text-muted-foreground">{t("stats.mcpErrors", { n: m.errors })}</span>}
        {m.faults > 0 && <span className="font-medium text-error">{t("stats.mcpFaults", { n: m.faults })}</span>}
        {(m.disconnects ?? 0) > 0 && <span className="font-medium text-error">{t("stats.mcpDisconnects", { n: m.disconnects! })}</span>}
        {(m.startFailures ?? 0) > 0 && <span className="font-medium text-error">{t("stats.mcpStartFailures", { n: m.startFailures! })}</span>}
        {m.avgMs != null && <span className="text-muted-foreground">{t("stats.mcpAvg", { t: quick(m.avgMs) })}</span>}
      </span>
      <span className="row-start-1 text-right text-xs text-muted-foreground sm:col-start-3">{m.lastUsedAt ? when.format(m.lastUsedAt) : "–"}</span>
    </div>
  )
  if (!m.tools.length) return <li>{summary}</li>

  return (
    <li>
      <Collapsible>
        <CollapsibleTrigger className="block w-full rounded-sm outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring" aria-label={t("stats.mcpShowTools", { name: m.name })}>
          {summary}
        </CollapsibleTrigger>
        <CollapsibleContent>
          <ul className="space-y-1 pb-3 pl-3 text-code">
            {m.tools.map(x => (
              <li key={x.tool} className="flex flex-wrap items-baseline gap-x-3">
                <span className="font-mono text-code">{x.tool}</span>
                <span className="tabular-nums text-muted-foreground">
                  ×{x.count}
                  {x.errors > 0 && <> · {t("stats.mcpErrors", { n: x.errors })}</>}
                  {x.faults > 0 && <span className="text-error"> · {t("stats.mcpFaults", { n: x.faults })}</span>}
                </span>
              </li>
            ))}
            {m.moreTools > 0 && <li className="text-muted-foreground">{t("stats.mcpMoreTools", { n: m.moreTools })}</li>}
          </ul>
        </CollapsibleContent>
      </Collapsible>
    </li>
  )
}

function Tag({ tone, children }: { tone?: "warn"; children: React.ReactNode }) {
  return <span className={cn("rounded-full border px-1.5 text-2xs leading-5 whitespace-nowrap text-muted-foreground", tone === "warn" && "border-waiting/50 text-waiting")}>{children}</span>
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
