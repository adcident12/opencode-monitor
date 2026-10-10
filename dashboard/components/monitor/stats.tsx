"use client"

import { useState } from "react"
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { compact, duration, quick, rough } from "@/lib/format"
import { useI18n } from "@/lib/i18n"
import { useStats } from "@/lib/live"
import type { DayStats, McpStat, Stats as StatsData } from "@/lib/types"
import { cn } from "@/lib/utils"
import { Code } from "./details"
import { SessionFilter } from "./session-filter"

const RANGES = [7, 14, 30] as const

const hours = (ms: number) => Math.round((ms / 3_600_000) * 10) / 10

/** @param session  the one session to count, kept in the URL so a card can link straight here */
export function Stats({ session, onSession }: { session: string | null; onSession: (id: string | null) => void }) {
  const { t } = useI18n()
  const [days, setDays] = useState<number>(14)
  const { stats, failed } = useStats(days, session, true)
  // The list comes with the figures; keep the last one so the filter does not empty while loading.
  const [choices, setChoices] = useState<StatsData["sessions"]>([])
  if (stats && stats.sessions !== choices) setChoices(stats.sessions)

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
        <SessionFilter value={session} onChange={onSession} sessions={choices} current={stats?.session} />
        <p className="text-sm text-muted-foreground">{t(session ? "stats.sourceSession" : "stats.source")}</p>
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

      <Speed stats={stats} />
      <Usage stats={stats} />
      <McpServers stats={stats} />

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
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="font-medium">{title}</h3>
        <span className="text-sm tabular-nums text-muted-foreground">{summary}</span>
      </div>
      <div className="h-48" role="img" aria-label={title}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: -18 }} barCategoryGap={data.length > 14 ? 2 : 6}>
            <CartesianGrid vertical={false} stroke="var(--color-border)" strokeDasharray="0" />
            <XAxis dataKey="label" tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={16} tick={{ fill: "var(--color-muted-foreground)", fontSize: 11 }} />
            <YAxis tickLine={false} axisLine={false} width={44} allowDecimals={false} tick={{ fill: "var(--color-muted-foreground)", fontSize: 11 }} tickFormatter={tick} />
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

/**
 * How fast each model answers. Writing and reading are kept apart: a slow first token is a
 * long or uncached prompt, slow writing is the server itself.
 */
function Speed({ stats }: { stats: StatsData }) {
  const { t } = useI18n()
  const { models } = stats.speed
  if (!models.length) return null
  const main = models[0]
  const tps = (n: number | null) => (n == null ? "–" : t("stats.speedTps", { n: n < 100 ? n.toFixed(1) : Math.round(n) }))
  const points = stats.daily.map((d, i) => ({ date: d.date, value: main.daily[i] ?? 0, text: tps(main.daily[i] ?? null) }))

  return (
    <section className="space-y-4">
      <div>
        <h3 className="font-medium">{t("stats.speed")}</h3>
        <p className="text-xs text-muted-foreground">{t("stats.speedNote")}</p>
      </div>
      <div className="grid gap-8 lg:grid-cols-2">
        <div className="overflow-x-auto">
          <table className="w-full text-[0.82rem]">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th scope="col" className="py-1.5 pr-3 font-normal">{t("stats.speedModel")}</th>
                <th scope="col" className="py-1.5 pr-3 text-right font-normal">{t("stats.speedWrite")}</th>
                <th scope="col" className="py-1.5 pr-3 text-right font-normal">{t("stats.speedRead")}</th>
                <th scope="col" className="py-1.5 text-right font-normal">{t("stats.speedFirst")}</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {models.map(m => (
                <tr key={m.model}>
                  <th scope="row" className="py-2 pr-3 text-left font-normal">
                    <span className="font-mono text-[0.78rem] break-all">{m.model}</span>
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
        <h3 className="font-medium">{t("stats.usage")}</h3>
        <p className="text-xs text-muted-foreground">{t("stats.usageNote", { n: usage.requests })}</p>
      </div>
      <div className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-4">
        <Tile label={t("stats.usageSent")} value={compact(sent)} note={usage.cachedPct == null ? "" : t("stats.usageCached", { pct: usage.cachedPct })} />
        <Tile label={t("stats.usageNew")} value={compact(usage.input + usage.cacheWrite)} note={t("stats.usageNewNote")} />
        <Tile label={t("stats.usageOutput")} value={compact(usage.output)} note={usage.reasoning ? t("stats.usageReasoning", { n: compact(usage.reasoning) }) : ""} />
        {usage.cost > 0 ? (
          <Tile label={t("stats.usageCost")} value={`$${usage.cost.toFixed(2)}`} note={t("stats.usageCostNote")} />
        ) : (
          usage.start && <Tile label={t("stats.usageStart")} value={compact(usage.start.median)} note={t("stats.usageStartRange", { min: compact(usage.start.min), max: compact(usage.start.max), n: usage.start.sessions })} />
        )}
      </div>
      {usage.start && (
        <p className="text-sm text-muted-foreground">
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
  // Failures logged before the oldest log line we have are unknown, not zero.
  const logShort = !stats.session && stats.mcpLogFrom != null && stats.mcpLogFrom > stats.range.from

  return (
    <section className="space-y-3">
      <div>
        <h3 className="font-medium">{t("stats.mcp")}</h3>
        <p className="text-xs text-muted-foreground">{t("stats.mcpNote")}</p>
      </div>
      <ul className="divide-y border-y">
        {stats.mcp.map(m => (
          <McpRow key={m.name} server={m} when={when} />
        ))}
      </ul>
      {unused.length > 0 && <p className="text-sm text-muted-foreground">{t(stats.session ? "stats.mcpUnusedSession" : "stats.mcpUnused", { names: unused.map(m => m.name).join(", ") })}</p>}
      {stats.session && <p className="text-xs text-muted-foreground">{t("stats.mcpNoLogForSession")}</p>}
      {logShort && <p className="text-xs text-muted-foreground">{t("stats.mcpLogFrom", { t: when.format(stats.mcpLogFrom!) })}</p>}
    </section>
  )
}

function McpRow({ server: m, when }: { server: McpStat; when: Intl.DateTimeFormat }) {
  const { t } = useI18n()
  const summary = (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-4 gap-y-1 py-2.5 text-left sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_auto]">
      <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className={cn("truncate font-mono text-[0.82rem]", !m.enabled && "text-muted-foreground")}>{m.name}</span>
        {!m.enabled && <Tag>{t("stats.mcpOff")}</Tag>}
        {m.scope === "project" && <Tag>{t("stats.mcpProject")}</Tag>}
        {m.unused && <Tag tone="warn">{t("stats.mcpNeverUsed")}</Tag>}
      </span>
      <span className="col-span-2 flex flex-wrap gap-x-3 gap-y-0.5 text-[0.82rem] tabular-nums sm:col-span-1">
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
          <ul className="space-y-1 pb-3 pl-3 text-[0.8rem]">
            {m.tools.map(x => (
              <li key={x.tool} className="flex flex-wrap items-baseline gap-x-3">
                <span className="font-mono text-[0.78rem]">{x.tool}</span>
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
  return <span className={cn("rounded-full border px-1.5 text-[0.68rem] leading-5 whitespace-nowrap text-muted-foreground", tone === "warn" && "border-waiting/50 text-waiting")}>{children}</span>
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
