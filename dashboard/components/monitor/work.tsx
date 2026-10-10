"use client"

import { compact, duration, money, rough } from "@/lib/format"
import { useI18n } from "@/lib/i18n"
import type { Stats } from "@/lib/types"
import { cn } from "@/lib/utils"
import { Facts, H3, SUB, TD, TH } from "./section"

type Work = Stats["work"]

/** The parts of the agent's time, in a fixed order; each has its own colour token. */
const PARTS = [
  { key: "readingMs", color: "var(--color-part-1)" },
  { key: "thinkingMs", color: "var(--color-part-2)" },
  { key: "writingMs", color: "var(--color-part-3)" },
  { key: "toolMs", color: "var(--color-part-4)" },
] as const

function Heading({ title, note }: Readonly<{ title: string; note?: string }>) {
  return (
    <div>
      <h3 className={H3}>{title}</h3>
      {note && <p className="mt-0.5 max-w-prose text-xs text-muted-foreground">{note}</p>}
    </div>
  )
}

/**
 * Where the agent's time went, as one bar split four ways. Every part is also written out
 * with its time and share, so nothing depends on telling the colours apart.
 */
export function TimeSplit({ work }: Readonly<{ work: Work }>) {
  const { t } = useI18n()
  const total = PARTS.reduce((n, p) => n + work.time[p.key], 0)
  if (!total) return null
  const pct = (ms: number) => Math.round((ms / total) * 100)
  const biggest = PARTS.reduce((a, b) => (work.time[b.key] > work.time[a.key] ? b : a))

  return (
    <section className={SUB}>
      <Heading title={t("work.time")} note={t("work.timeNote")} />
      <div role="img" aria-label={PARTS.map(p => `${t(`work.part.${p.key}`)} ${pct(work.time[p.key])}%`).join(", ")} className="flex h-3 w-full gap-0.5 overflow-hidden rounded-full">
        {PARTS.filter(p => work.time[p.key] > 0).map(p => (
          <span key={p.key} title={`${t(`work.part.${p.key}`)}: ${rough(work.time[p.key])}`} className="h-full first:rounded-l-full last:rounded-r-full" style={{ width: `${(work.time[p.key] / total) * 100}%`, background: p.color }} />
        ))}
      </div>
      <Facts
        className="grid-cols-2 sm:grid-cols-4"
        items={PARTS.map(p => ({
          key: p.key,
          label: (
            <span className="flex items-center gap-2">
              <span aria-hidden className="size-2.5 shrink-0 rounded-sm" style={{ background: p.color }} />
              {t(`work.part.${p.key}`)}
            </span>
          ),
          value: (
            <>
              {rough(work.time[p.key])} <span className="font-normal text-muted-foreground">· {pct(work.time[p.key])}%</span>
            </>
          ),
        }))}
      />
      <p className="max-w-prose text-sm text-muted-foreground">{t(`work.biggest.${biggest.key}`, { pct: pct(work.time[biggest.key]) })}</p>
    </section>
  )
}

const ENDINGS = ["done", "continued", "cut", "aborted", "error", "unanswered", "open"] as const

/** Each prompt you wrote: how many steps, how long, and how it ended. */
export function Turns({ work }: Readonly<{ work: Work }>) {
  const { t, lang } = useI18n()
  const { turns } = work
  if (!turns.count) return null
  const when = new Intl.DateTimeFormat(lang, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false })
  const tone: Partial<Record<(typeof ENDINGS)[number], string>> = { cut: "text-stuck", error: "text-error" }

  return (
    <section className={SUB}>
      <Heading title={t("work.turns")} note={t("work.turnsNote", { n: turns.count })} />
      <Facts
        className="grid-cols-3"
        items={[
          { key: "steps", label: t("work.medianSteps"), value: turns.medianSteps ?? "–" },
          { key: "time", label: t("work.medianTime"), value: turns.medianMs == null ? "–" : duration(turns.medianMs) },
          { key: "longest", label: t("work.longest"), value: turns.longestMs == null ? "–" : duration(turns.longestMs) },
        ]}
      />
      <ul className="divide-y border-y text-sm">
        {ENDINGS.filter(e => turns.ended[e] > 0).map(e => (
          <li key={e} className="flex items-baseline justify-between gap-4 py-2">
            <span className={tone[e]}>{t(`work.ending.${e}`)}</span>
            <span className="tabular-nums">
              {turns.ended[e]} <span className="text-xs text-muted-foreground">· {Math.round((turns.ended[e] / turns.count) * 100)}%</span>
            </span>
          </li>
        ))}
      </ul>
      {turns.ended.cut > 0 && (
        <div className="space-y-1 rounded-lg bg-stuck-soft/60 px-3.5 py-2.5 text-sm">
          <p className="text-stuck">{t("work.cutNote", { n: turns.ended.cut })}</p>
          <ul className="text-xs text-muted-foreground">
            {turns.cut.slice(0, 5).map(c => (
              <li key={c.at}>
                {when.format(c.at)} · <span className="font-mono">{c.project}</span>
                {c.model && <> · {c.model}</>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}

/** Time, tokens and cost per agent. Only worth a table when more than one agent worked. */
export function Agents({ work }: Readonly<{ work: Work }>) {
  const { t } = useI18n()
  const agents = work.agents
  if (agents.length < 2) return null
  const paid = agents.some(a => a.cost > 0)
  const max = Math.max(1, ...agents.map(a => a.activeMs))

  return (
    <section className={SUB}>
      <Heading title={t("work.agents")} note={t("work.agentsNote")} />
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b">
              <th scope="col" className={TH}>{t("work.agent")}</th>
              <th scope="col" className={TH}>{t("effort.active")}</th>
              <th scope="col" className={cn(TH, "text-right")}>{t("work.requests")}</th>
              <th scope="col" className={cn(TH, "text-right")}>{t("effort.tokens")}</th>
              {paid && <th scope="col" className={cn(TH, "text-right")}>{t("effort.cost")}</th>}
            </tr>
          </thead>
          <tbody className="divide-y">
            {agents.map(a => (
              <tr key={a.agent}>
                <th scope="row" className={cn(TD, "text-left font-normal")}>
                  <span className="font-mono text-code">{a.agent}</span>
                  {a.subagent && <span className="ml-2 text-xs text-muted-foreground">{t("work.subagent")}</span>}
                </th>
                <td className={cn(TD, "whitespace-nowrap")}>
                  <span className="flex items-center gap-2 tabular-nums">
                    <span className="hidden h-1.5 w-16 rounded-full bg-muted sm:block" aria-hidden>
                      <span className="block h-full rounded-full bg-working/70" style={{ width: `${(a.activeMs / max) * 100}%` }} />
                    </span>
                    {rough(a.activeMs)}
                  </span>
                </td>
                <td className={cn(TD, "text-right tabular-nums text-muted-foreground")}>{a.requests}</td>
                <td className={cn(TD, "text-right tabular-nums text-muted-foreground")}>{a.tokens ? compact(a.tokens) : "–"}</td>
                {paid && <td className={cn(TD, "text-right tabular-nums")}>{a.cost > 0 ? money(a.cost) : "–"}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

/**
 * What interrupted you most. The rule shown is a suggestion to copy into opencode.json; the
 * monitor never changes OpenCode's config.
 */
export function Permissions({ work }: Readonly<{ work: Work }>) {
  const { t } = useI18n()
  const { permissions } = work
  if (!permissions.asked) return null
  return (
    <section className={SUB}>
      <Heading title={t("work.permissions")} note={t("work.permissionsNote", { n: permissions.asked })} />
      <ol className="divide-y border-y">
        {permissions.top.map(p => (
          <li key={`${p.permission}|${p.pattern}`} className="grid grid-cols-[3.75rem_minmax(0,1fr)] items-baseline gap-x-3 py-2.5">
            <span className="font-medium tabular-nums">×{p.count}</span>
            <span className="min-w-0 space-y-1">
              <span className="block text-sm">{p.permission}</span>
              {p.pattern && <code className="block font-mono text-code break-words whitespace-pre-wrap text-muted-foreground">{p.pattern}</code>}
              {p.waitMs > 0 && <span className="block text-xs text-muted-foreground">{t("work.permissionWait", { t: duration(p.waitMs) })}</span>}
            </span>
          </li>
        ))}
      </ol>
      <p className="max-w-prose text-xs text-muted-foreground">{t("work.permissionsHow")}</p>
    </section>
  )
}

/** Files the agent changed, and which it kept coming back to. */
export function Files({ work }: Readonly<{ work: Work }>) {
  const { t } = useI18n()
  const { files } = work
  if (!files.edits) return null
  return (
    <section className={SUB}>
      <Heading title={t("work.filesChanged")} note={t("work.filesNote", { edits: files.edits, files: files.files })} />
      <ol className="divide-y border-y">
        {files.top.map(f => (
          <li key={`${f.project}|${f.file}`} className="grid grid-cols-[3.75rem_minmax(0,1fr)_auto] items-baseline gap-x-3 py-2">
            <span className="font-medium tabular-nums">×{f.count}</span>
            <code className="min-w-0 font-mono text-code break-words">{f.file}</code>
            <span className="max-w-[10rem] truncate font-mono text-xs text-muted-foreground">{f.project}</span>
          </li>
        ))}
      </ol>
    </section>
  )
}

/** The agent's own task lists: how many items it finished, and where it left some undone. */
export function Plans({ work }: Readonly<{ work: Work }>) {
  const { t } = useI18n()
  const { plans } = work
  if (!plans.total) return null
  const pct = Math.round((plans.completed / plans.total) * 100)
  return (
    <section className={SUB}>
      <Heading title={t("work.plans")} note={t("work.plansNote", { n: plans.sessions })} />
      <div className="space-y-1.5">
        <div className="h-2 w-full overflow-hidden rounded-full bg-muted" role="img" aria-label={t("work.plansDone", { done: plans.completed, total: plans.total, pct })}>
          <div className="h-full rounded-full bg-finished" style={{ width: `${pct}%` }} />
        </div>
        <p className="text-sm tabular-nums">
          {t("work.plansDone", { done: plans.completed, total: plans.total, pct })}
          {plans.dropped > 0 && <span className="text-waiting"> · {t("work.plansDropped", { n: plans.dropped })}</span>}
          {plans.inProgress + plans.pending > 0 && <span className="text-muted-foreground"> · {t("work.plansOpen", { n: plans.inProgress + plans.pending })}</span>}
        </p>
        {plans.rewrites > 0 && <p className="max-w-prose text-xs text-muted-foreground">{t("work.plansRewrites", { n: plans.rewrites })}</p>}
      </div>
      {plans.unfinished.length > 0 && (
        <ol className="divide-y border-y">
          {plans.unfinished.map(p => (
            <li key={p.id} className="grid grid-cols-[3.75rem_minmax(0,1fr)_auto] items-baseline gap-x-3 py-2 text-sm">
              <span className="font-medium tabular-nums text-waiting">{p.pending + p.inProgress + p.dropped}</span>
              <span className="min-w-0 truncate">{p.title || p.id}</span>
              <span className="text-xs tabular-nums text-muted-foreground">
                {t("work.plansOf", { done: p.completed, total: p.total })}
                {p.dropped > 0 && <> · {t("work.plansDroppedShort", { n: p.dropped })}</>}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}
