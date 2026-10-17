"use client"

import { Skeleton } from "@/components/ui/skeleton"
import { duration } from "@/lib/format"
import { useI18n } from "@/lib/i18n"
import { useOvernight } from "@/lib/live"
import type { Overnight as OvernightData, OvernightSession } from "@/lib/types"
import { cn } from "@/lib/utils"
import { Hint } from "./hint"
import { ReplayLink } from "./replay-link"
import { Chapter } from "./section"
import { StateBadge } from "./state"

/** What each session did while you were away, how it stood at the end, and the hours lost. */
export function Overnight() {
  const { t, lang } = useI18n()
  const report = useOvernight(true)
  const time = (ms: number) => new Intl.DateTimeFormat(lang, { weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ms))
  const window = report && (report.going ? t("overnight.going", { from: time(report.from) }) : t("overnight.window", { from: time(report.from), to: time(report.to) }))
  return (
    <Chapter id="overnight" first title={t("overnight.title")} note={t("overnight.note")} action={window ? <span className="text-sm text-muted-foreground tabular-nums">{window}</span> : undefined}>
      {!report && <Skeleton className="h-20 w-full rounded-xl" />}
      {report && <Report report={report} />}
    </Chapter>
  )
}

function Report({ report }: Readonly<{ report: OvernightData }>) {
  const { t, lang } = useI18n()
  const at = (ms: number) => new Intl.DateTimeFormat(lang, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ms))
  const { totals } = report
  if (!report.recorded) return <p className="text-sm text-muted-foreground">{t("overnight.notRecorded")}</p>
  if (!totals.sessions) return <p className="text-sm text-muted-foreground">{t("overnight.none")}</p>
  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <p className="text-sm font-medium">{t("overnight.summary", { n: totals.sessions, worked: duration(totals.workedMs), finished: totals.finished, unfinished: totals.unfinished, working: totals.working })}</p>
        {/* The night's lost hours: the first thing to know in the morning. */}
        {totals.longestStill && totals.longestStill.ms >= 10 * 60_000 && (
          <p className="text-sm text-waiting">{t("overnight.still", { span: duration(totals.longestStill.ms), from: at(totals.longestStill.from), to: at(totals.longestStill.to) })}</p>
        )}
      </div>
      <ul className="divide-y rounded-xl border bg-card">
        {report.sessions.map(s => (
          <Row key={s.id} session={s} at={at} />
        ))}
      </ul>
    </div>
  )
}

function Row({ session: s, at }: Readonly<{ session: OvernightSession; at: (ms: number) => string }>) {
  const { t } = useI18n()
  const why = s.reason ? t(`reason.${s.reason}`, { permission: s.permission ?? "", limit: s.limitMs ? duration(s.limitMs) : "", detail: s.error ?? "" }) : null
  return (
    <li className="space-y-1.5 px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        <StateBadge state={s.state} label={t(`state.${s.state}`)} className="h-5 text-xs" />
        <Hint label={s.title || s.id} onlyWhenCut className="min-w-48 flex-1 truncate text-sm font-medium">
          {s.title || s.id}
        </Hint>
        <span className="font-mono text-code text-muted-foreground">{s.project}</span>
        <ReplayLink id={s.id} />
      </div>
      <p className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground tabular-nums">
        {why && <span className={cn(s.unfinished && "text-foreground")}>{why}</span>}
        {s.state !== "working" && <span>{t("overnight.stopped", { at: at(s.since) })}</span>}
        <span>{t("overnight.worked", { t: duration(s.workedMs) })}</span>
        {s.waitedMs > 0 && <span>{t("overnight.waited", { t: duration(s.waitedMs) })}</span>}
        {s.plan && <span>{t("overnight.plan", { done: s.plan.done, total: s.plan.total })}</span>}
      </p>
    </li>
  )
}
