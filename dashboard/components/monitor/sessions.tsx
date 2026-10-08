"use client"

import { Card, CardContent } from "@/components/ui/card"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { clock, duration, rough } from "@/lib/format"
import { useI18n } from "@/lib/i18n"
import type { Session } from "@/lib/types"
import { cn } from "@/lib/utils"
import { Code, Health, Hints, Output, Review, Steps, Todos, Work } from "./details"
import { STATE_STYLE, StateBadge } from "./state"

function useReason() {
  const { t } = useI18n()
  return (s: Session) =>
    t(`reason.${s.reason}`, { permission: s.prompt?.permission ?? "", limit: s.limitMs ? rough(s.limitMs) : "", detail: s.detail ?? "" })
}

function Project({ session }: { session: Session }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span tabIndex={0} />} className="rounded-sm font-mono text-[0.78rem] text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {session.project}
      </TooltipTrigger>
      <TooltipContent>{session.directory}</TooltipContent>
    </Tooltip>
  )
}

/** The command or tool call in progress, with its output when it is a shell command. */
function Current({ session, now }: { session: Session; now: number }) {
  const { t } = useI18n()
  const current = session.current
  if (!current?.summary) return null
  return (
    <div className="space-y-2 rounded-lg border border-border/80 bg-muted/40 px-3.5 py-2.5">
      <div className="flex items-baseline justify-between gap-3 text-xs text-muted-foreground">
        <span>{current.tool}</span>
        <span className="tabular-nums">{t("time.running", { t: duration(now - current.startedAt) })}</span>
      </div>
      <Code>{current.summary}</Code>
      {current.tool === "bash" && (
        <div className="border-t border-border/70 pt-2">
          <Output output={current.output} now={now} />
        </div>
      )}
    </div>
  )
}

function Subagents({ items, now }: { items: Session[]; now: number }) {
  const { t } = useI18n()
  if (!items.length) return null
  return (
    <div className="space-y-1.5 border-t border-border/70 pt-2">
      <p className="text-xs text-muted-foreground">{t("subagents")}</p>
      {items.map(child => (
        <div key={child.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.85rem]">
          <StateBadge state={child.state} label={t(`state.${child.state}`)} className="h-5 text-xs" />
          <span className="min-w-0 break-words">{child.title || child.id}</span>
          <span className={cn("tabular-nums", STATE_STYLE[child.state].text)}>{duration(now - child.since)}</span>
        </div>
      ))}
    </div>
  )
}

/**
 * Something needs the user. The elapsed clock is the largest thing on the page: the
 * question this card answers is "how long has this been waiting on me?".
 */
export function AttentionCard({ session, subagents, now }: { session: Session; subagents: Session[]; now: number }) {
  const { t } = useI18n()
  const reason = useReason()
  const style = STATE_STYLE[session.state]

  return (
    <Card className={cn("relative gap-0 overflow-hidden py-0 ring-1", style.ring)}>
      <span aria-hidden className={cn("absolute inset-y-0 left-0 w-1", style.bar)} />
      <CardContent className="space-y-4 py-5 pr-5 pl-6">
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
          <div className="min-w-0 space-y-2">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <StateBadge state={session.state} label={t(`state.${session.state}`)} />
              <Project session={session} />
            </div>
            <h3 className="text-lg leading-snug font-medium break-words">{session.title || session.id}</h3>
          </div>
          <div className="text-right">
            <p className={cn("font-light tabular-nums leading-none tracking-tight text-[clamp(2.25rem,6vw,3.25rem)]", style.text)} aria-label={t("time.for", { t: duration(now - session.since) })}>
              {clock(now - session.since)}
            </p>
            <p className="mt-1.5 text-xs text-muted-foreground">{t(`timer.${session.state}`)}</p>
          </div>
        </div>

        {session.prompt?.detail ? (
          <div className={cn("space-y-1 rounded-lg px-3.5 py-2.5", style.soft)}>
            <p className={cn("text-[0.82rem] font-medium", style.text)}>{reason(session)}</p>
            <Code>{session.prompt.detail}</Code>
          </div>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">{reason(session)}</p>
            <Current session={session} now={now} />
          </>
        )}

        {session.state !== "waiting" && session.health.lastError && (
          <div className="space-y-1 rounded-lg bg-error-soft/60 px-3.5 py-2.5">
            <p className="text-[0.82rem] font-medium text-error">{t("health.lastError", { tool: session.health.lastError.tool })}</p>
            <Code>{session.health.lastError.text}</Code>
          </div>
        )}

        <Health session={session} now={now} showActivity />
        <Hints session={session} now={now} />
        <Subagents items={subagents} now={now} />
        <Work session={session} />
        <Review session={session} />
      </CardContent>
    </Card>
  )
}

/** Busy and fine: what it is doing right now and how far it has got. */
export function WorkingCard({ session, subagents, now }: { session: Session; subagents: Session[]; now: number }) {
  const { t } = useI18n()
  const reason = useReason()
  const { steps, todos } = session.progress
  const showSteps = steps.length > 1 || (steps.length === 1 && steps[0].status !== "running")

  return (
    <Card className="gap-0 py-0">
      <CardContent className="space-y-3.5 px-5 py-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <StateBadge state="working" label={t("state.working")} />
          <span className="tabular-nums text-sm text-working">{duration(now - session.since)}</span>
          <span className="ml-auto">
            <Project session={session} />
          </span>
        </div>
        <div className="space-y-0.5">
          <h3 className="text-base leading-snug font-medium break-words">{session.title || session.id}</h3>
          <p className="text-sm text-muted-foreground">{reason(session)}</p>
        </div>
        <Current session={session} now={now} />
        <Todos todos={todos} />
        {showSteps && <Steps steps={steps} now={now} />}
        <Health session={session} now={now} showActivity />
        <Hints session={session} now={now} />
        <Subagents items={subagents} now={now} />
        <Work session={session} />
        <Review session={session} />
      </CardContent>
    </Card>
  )
}

/** Finished or idle: one line, with the details folded away. */
export function QuietRow({ session, now }: { session: Session; now: number }) {
  const { t } = useI18n()
  const reason = useReason()
  return (
    <li className="space-y-2 px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <StateBadge state={session.state} label={t(`state.${session.state}`)} className="h-5 text-xs" />
        <span className="min-w-0 flex-1 truncate text-[0.92rem]">{session.title || session.id}</span>
        <span className="text-xs text-muted-foreground">{reason(session)}</span>
        <span className="tabular-nums text-xs text-muted-foreground">{t("time.ago", { t: rough(now - session.since) })}</span>
        <Project session={session} />
      </div>
      {(session.review.total > 0 || session.work.warnProtected) && (
        <div className="space-y-1">
          <Work session={session} />
          <Review session={session} />
        </div>
      )}
    </li>
  )
}
