"use client"

import { useState } from "react"
import { CircleDotIcon, CircleIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { rough } from "@/lib/format"
import { useI18n } from "@/lib/i18n"
import { useTasks } from "@/lib/live"
import type { State, TaskEnd, TaskSession, Tasks as TasksData } from "@/lib/types"
import { cn } from "@/lib/utils"
import { Hint } from "./hint"
import { Overnight } from "./overnight"
import { ReplayLink } from "./replay-link"
import { Chapter, H3, SUB, TAB } from "./section"
import { StateBadge } from "./state"

const RANGES = [7, 14, 30] as const
// Plan items shown before "n more": enough to see where it stopped.
const SHOWN_ITEMS = 5

// How it ended, in the colours of the Now tab: handed back is a finished turn, interrupted is idle.
const BADGE: Record<TaskEnd, State> = { working: "working", waiting: "waiting", stuck: "stuck", error: "error", interrupted: "idle", stopped: "finished" }

/** Every session of a period by project: what it was for, how it ended, and what is left of its plan. */
export function Tasks() {
  const { t } = useI18n()
  const [days, setDays] = useState<number>(7)
  const [openOnly, setOpenOnly] = useState(false)
  const { tasks, failed } = useTasks(days, true)

  return (
    <div className={TAB}>
      <Overnight />
      <Chapter
        id="tasks"
        title={t("tasks.title")}
        note={t("tasks.note")}
        action={
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
            <Button variant={openOnly ? "secondary" : "outline"} size="sm" aria-pressed={openOnly} onClick={() => setOpenOnly(v => !v)}>
              {t("tasks.openOnly")}
            </Button>
          </div>
        }
      >
        {failed && !tasks && <p className="text-sm text-error">{t("tasks.failed")}</p>}
        {!tasks && !failed && <Loading />}
        {tasks && <List tasks={tasks} openOnly={openOnly} />}
      </Chapter>
    </div>
  )
}

function List({ tasks, openOnly }: Readonly<{ tasks: TasksData; openOnly: boolean }>) {
  const { t } = useI18n()
  const projects = tasks.projects.map(p => ({ ...p, sessions: p.sessions.filter(s => !openOnly || s.open) })).filter(p => p.sessions.length)
  if (!tasks.total) return <p className="text-sm text-muted-foreground">{t("tasks.none")}</p>
  return (
    <div className="space-y-8">
      <p className="text-sm font-medium">{t("tasks.summary", { open: tasks.open, total: tasks.total, n: tasks.total })}</p>
      {!projects.length && <p className="text-sm text-muted-foreground">{t("tasks.noneOpen")}</p>}
      {projects.map(p => (
        <section key={p.directory} aria-label={p.project || p.directory} className={SUB}>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h3 className={cn(H3, "break-words")}>{p.project || p.directory}</h3>
            {p.open > 0 && <span className="text-sm text-waiting">{t("tasks.projectOpen", { n: p.open })}</span>}
          </div>
          <ul className="divide-y rounded-xl border bg-card">
            {p.sessions.map(s => (
              <Row key={s.id} session={s} now={tasks.range.to} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

function Row({ session: s, now }: Readonly<{ session: TaskSession; now: number }>) {
  const { t } = useI18n()
  const [all, setAll] = useState(false)
  const shown = all ? s.left : s.left.slice(0, SHOWN_ITEMS)
  const hidden = s.left.length - shown.length + s.more
  const planLabel = s.plan && t("progress.todos", { done: s.plan.done, total: s.plan.total })
  return (
    <li className="space-y-2.5 px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        <StateBadge state={BADGE[s.ended]} label={t(`tasks.ended.${s.ended}`)} className="h-5 text-xs" />
        <Hint label={s.title || s.id} onlyWhenCut className="min-w-48 flex-1 truncate text-sm font-medium">
          {s.title || s.id}
        </Hint>
        {/* No plan, nothing to show: the agent did not write one for a small job. */}
        {s.plan && planLabel && (
          <span className="flex items-center gap-2 text-xs text-muted-foreground tabular-nums">
            {planLabel}
            <Progress value={(s.plan.done / Math.max(1, s.plan.total)) * 100} className="w-16" aria-label={planLabel} />
          </span>
        )}
        <span className="text-xs text-muted-foreground tabular-nums">{t("time.ago", { t: rough(Math.max(0, now - s.lastAt)) })}</span>
        <ReplayLink id={s.id} />
      </div>
      {s.left.length > 0 && (
        <div className="space-y-1.5 pl-1">
          <p className="text-xs text-muted-foreground">{t("tasks.left")}</p>
          <ul className="space-y-1">
            {shown.map((item, i) => (
              <li key={`${i}-${item.content}`} className="flex items-start gap-2 text-sm">
                {item.status === "in_progress" ? <CircleDotIcon className="mt-0.5 size-3.5 shrink-0 text-working" aria-label={t("tasks.inProgress")} /> : <CircleIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />}
                <span className="min-w-0 [overflow-wrap:anywhere]">{item.content}</span>
              </li>
            ))}
          </ul>
          {(hidden > 0 || all) && s.left.length > SHOWN_ITEMS && (
            <button type="button" onClick={() => setAll(v => !v)} className="rounded-sm text-xs text-muted-foreground underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring">
              {all ? t("tasks.less") : t("tasks.more", { n: hidden })}
            </button>
          )}
          {all && s.more > 0 && <p className="text-xs text-muted-foreground">{t("tasks.more", { n: s.more })}</p>}
        </div>
      )}
    </li>
  )
}

function Loading() {
  return (
    <div className="space-y-3">
      <Skeleton className="h-5 w-48" />
      <Skeleton className="h-24 w-full rounded-xl" />
      <Skeleton className="h-24 w-full rounded-xl" />
    </div>
  )
}
