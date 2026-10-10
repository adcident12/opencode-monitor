"use client"

import { ActivityIcon, ChevronRightIcon, GitBranchIcon, ShieldAlertIcon } from "lucide-react"
import { useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Progress } from "@/components/ui/progress"
import { duration, kilo, rough } from "@/lib/format"
import { useI18n } from "@/lib/i18n"
import type { FlagKind, Session, Step } from "@/lib/types"
import { cn } from "@/lib/utils"

/** A command, path, or question exactly as the agent wrote it. */
export function Code({ children, className }: { children: React.ReactNode; className?: string }) {
  return <code className={cn("block font-mono text-code break-words whitespace-pre-wrap", className)}>{children}</code>
}

/** What the running command has printed, and how long ago its last line came. */
export function Output({ output, now }: { output: NonNullable<Session["current"]>["output"]; now: number }) {
  const { t } = useI18n()
  if (!output) return <p className="text-xs text-muted-foreground">{t("output.none")}</p>
  const quiet = now - output.at
  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground">
        {t("output.last")} · <span className={cn(quiet > 5 * 60_000 && "font-medium text-stuck")}>{t("time.ago", { t: duration(quiet) })}</span>
      </p>
      <pre className="max-h-40 overflow-auto font-mono text-code text-muted-foreground">{output.lines.join("\n")}</pre>
    </div>
  )
}

const MARK: Record<Step["status"], string> = { completed: "✓", error: "✕", running: "●", pending: "●" }

export function Steps({ steps, now }: { steps: Step[]; now: number }) {
  const { t } = useI18n()
  return (
    <div className="space-y-1.5">
      <p className="text-xs text-muted-foreground">{t("progress.steps")}</p>
      <ol className="space-y-0.5 text-sm">
        {steps.map((step, i) => {
          const live = step.status === "running" || step.status === "pending"
          return (
            <li key={`${step.startedAt}-${i}`} className={cn("grid grid-cols-[1rem_minmax(3rem,max-content)_1fr_auto] items-baseline gap-2", live ? "font-medium" : "text-muted-foreground")}>
              <span aria-hidden className={cn(step.status === "completed" && "text-finished", step.status === "error" && "text-error", live && "animate-breathe text-working")}>
                {MARK[step.status]}
              </span>
              <span>{step.tool}</span>
              <span className={cn("truncate font-mono text-code", step.status === "error" && "text-error")}>{step.text}</span>
              <span className="tabular-nums">{live ? duration(now - step.startedAt) : step.durationMs == null ? "" : duration(step.durationMs)}</span>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

export function Todos({ todos }: { todos: Session["progress"]["todos"] }) {
  const { t } = useI18n()
  if (!todos) return null
  return (
    <div className="flex items-center gap-3 text-sm">
      <span className="shrink-0 tabular-nums text-muted-foreground">{t("progress.todos", { done: todos.done, total: todos.total })}</span>
      <Progress value={(todos.done / Math.max(1, todos.total)) * 100} className="w-20 shrink-0" aria-label={t("progress.todos", { done: todos.done, total: todos.total })} />
      {todos.current && <span className="min-w-0 truncate">{todos.current}</span>}
    </div>
  )
}

/** Context, compactions, age, errors: one quiet line, with the numbers that are bad in colour. */
export function Health({ session, now, showActivity }: { session: Session; now: number; showActivity: boolean }) {
  const { t } = useI18n()
  const h = session.health
  const warn = (hint: string) => h.hints.includes(hint)
  const items: { key: string; label: string; value: React.ReactNode; bad?: boolean }[] = []

  if (showActivity && session.progress.lastActivityAt) {
    items.push({ key: "activity", label: t("progress.lastActivity"), value: t("time.ago", { t: duration(now - session.progress.lastActivityAt) }) })
  }
  if (h.compacting) {
    items.push({ key: "context", label: t("health.context"), value: <span className="text-muted-foreground">{t("health.compacting")}</span> })
  } else if (h.contextTokens != null) {
    items.push({
      key: "context",
      label: t("health.context"),
      bad: warn("context_high"),
      value:
        h.contextPct != null ? (
          <span className="block space-y-0.5">
            <span className="inline-flex items-center gap-2">
              <ContextBar session={session} high={warn("context_high")} />
              {kilo(h.contextTokens)} / {kilo(h.contextLimit ?? 0)} · {h.contextPct}%
            </span>
            {h.compaction && (
              <span className={cn("block text-xs", warn("context_high") ? "text-stuck" : "font-normal text-muted-foreground")}>
                {h.compaction.room === 0
                  ? t("health.compactNow")
                  : t(h.compaction.requestsLeft == null ? "health.compactRoom" : "health.compactRoomRequests", { room: kilo(h.compaction.room), n: h.compaction.requestsLeft ?? 0 })}
              </span>
            )}
          </span>
        ) : (
          t("health.contextUnknown", { n: kilo(h.contextTokens) })
        ),
    })
  }
  if (h.compactions) items.push({ key: "compactions", label: t("health.compactions"), value: h.compactions, bad: warn("many_compactions") })
  items.push({ key: "age", label: t("health.age"), value: rough(now - session.createdAt), bad: warn("old_session") })
  if (h.toolErrors) items.push({ key: "errors", label: t("health.toolErrors"), value: `${h.toolErrors} / ${h.toolCalls}`, bad: warn("many_errors") })

  return (
    <dl className="grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-x-6 gap-y-3 border-t border-border/70 pt-3 text-sm">
      {items.map(item => (
        <div key={item.key} className={cn("space-y-0.5", item.key === "context" && "col-span-2")}>
          <dt className="text-xs text-muted-foreground">{item.label}</dt>
          <dd className={cn("tabular-nums", item.bad && "font-medium text-stuck")}>{item.value}</dd>
        </div>
      ))}
    </dl>
  )
}

/**
 * The context window as a bar, with a tick where OpenCode will compact: the part of the bar
 * that matters is the stretch up to the tick, not the whole window.
 */
function ContextBar({ session, high }: { session: Session; high: boolean }) {
  const { t } = useI18n()
  const h = session.health
  const tick = h.compaction && h.contextLimit ? Math.min(100, (h.compaction.at / h.contextLimit) * 100) : null
  return (
    <span className="relative inline-block w-24">
      <Progress value={Math.min(100, h.contextPct ?? 0)} className={cn("w-full", high && "[&_[data-slot=progress-indicator]]:bg-stuck")} aria-label={t("health.context")} />
      {tick != null && <span aria-hidden className="absolute -top-1 h-3 w-px bg-foreground/60" style={{ left: `${tick}%` }} />}
    </span>
  )
}

export function Hints({ session, now }: { session: Session; now: number }) {
  const { t } = useI18n()
  const h = session.health
  if (!h.hints.length) return null
  const text: Record<string, () => string> = {
    context_high: () =>
      h.compaction
        ? t(h.compaction.requestsLeft == null ? "hint.compact_soon" : "hint.compact_soon_requests", { room: kilo(h.compaction.room), n: h.compaction.requestsLeft ?? 0 })
        : t("hint.context_high", { pct: h.contextPct ?? 0 }),
    many_compactions: () => t("hint.many_compactions", { n: h.compactions }),
    old_session: () => t("hint.old_session", { t: rough(now - session.createdAt) }),
    looping: () => t("hint.looping", { tool: h.repeat?.tool ?? "", n: h.repeat?.count ?? 0, text: h.repeat?.text ?? "" }),
    many_errors: () => t("hint.many_errors", { n: h.toolErrors }),
  }
  return (
    <div className="space-y-1 rounded-lg bg-stuck-soft/60 px-3 py-2 text-sm">
      <ul className="space-y-0.5 text-stuck">
        {h.hints.map(hint => (
          <li key={hint} className="break-words">
            {text[hint]?.() ?? hint}
          </li>
        ))}
      </ul>
      {h.suggestNewSession && <p className="font-medium">{t("hint.new_session")}</p>}
    </div>
  )
}

/** A fold-out section whose open state survives the re-render on every update. */
function Section({ title, summary, children }: { title: string; summary: React.ReactNode; children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="border-t border-border/70 pt-2">
      <CollapsibleTrigger className="group flex w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-md py-1 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <ChevronRightIcon className="size-3.5 text-muted-foreground transition-transform group-data-panel-open:rotate-90" aria-hidden />
        <span className="font-medium">{title}</span>
        {summary}
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-3 pt-2 pb-1 pl-6 text-sm">{children}</CollapsibleContent>
    </Collapsible>
  )
}

export function Work({ session }: { session: Session }) {
  const { t } = useI18n()
  const { files, git, warnProtected, warnUnknownBranch, running } = session.work
  if (!files.count && !git && !running?.items.length) return null

  const summary = (
    <>
      {git?.branch && (
        <Badge variant="outline" className={cn("gap-1 font-mono", warnProtected && "border-stuck/50 text-stuck")}>
          <GitBranchIcon aria-hidden />
          {t(git.detached ? "work.detached" : "work.branch", { branch: git.branch })}
        </Badge>
      )}
      {!git?.branch && warnUnknownBranch && <Badge variant="outline" className="border-stuck/50 text-stuck">{t("work.branchUnknown")}</Badge>}
      {git?.state === "pending" && <span className="text-muted-foreground">{t("work.checking")}</span>}
      {git?.state === "unreadable" && <Badge variant="outline" className="border-stuck/50 text-stuck">{t("work.gitUnreadable")}</Badge>}
      {files.count > 0 && <span className="text-muted-foreground">{t("work.files", { n: files.count })}</span>}
      {running && running.items.length > 0 && (
        <Badge variant="outline" className="gap-1 border-stuck/50 text-stuck">
          <ActivityIcon aria-hidden />
          {t("work.stillRunning", { n: running.items.length })}
        </Badge>
      )}
      {running?.failed && <span className="text-muted-foreground">{t("work.processCheckFailed")}</span>}
    </>
  )

  return (
    <Section title={t("work.title")} summary={summary}>
      {warnProtected && git?.branch && <p className="text-stuck">{t("work.protected", { branch: git.branch })}</p>}
      {warnUnknownBranch && <p className="text-stuck">{t("work.unknownBranch")}</p>}
      {git?.state === "unreadable" && <p className="text-stuck">{t("work.unreadable")}</p>}
      {running && running.items.length > 0 && <Running items={running.items} />}
      {files.recent.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">{t("work.recentFiles")}</p>
          <ul className="space-y-0.5 font-mono text-code">
            {files.recent.map(file => (
              <li key={file} className="break-all">
                {file}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Section>
  )
}

/** Background processes the agent started that are still alive, and how to stop them yourself. */
function Running({ items }: { items: NonNullable<Session["work"]["running"]>["items"] }) {
  const { t } = useI18n()
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">{t("work.runningTitle")}</p>
      <ul className="space-y-3">
        {items.map(item => (
          <li key={item.pid} className="space-y-1 rounded-lg border border-stuck/30 bg-stuck-soft/40 px-3 py-2">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
              <span className="font-medium">{item.name}</span>
              <span className="font-mono text-xs tabular-nums text-muted-foreground">PID {item.pid}</span>
              {item.processes > 1 && <span className="text-xs text-muted-foreground">{t("work.processTree", { n: item.processes })}</span>}
              {item.ports.length > 0 && <span className="text-xs font-medium text-stuck">{t("work.listening", { ports: item.ports.join(", ") })}</span>}
            </div>
            <Code className="text-muted-foreground">{item.from}</Code>
            <p className="text-xs text-muted-foreground">
              {t("work.stopHint")} <code className="font-mono">{stopCommand(item.pid)}</code>
            </p>
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">{t("work.runningNote")}</p>
    </div>
  )
}

// The monitor never stops anything itself; it only shows the command for the user's system.
function stopCommand(pid: number) {
  const windows = typeof navigator !== "undefined" && /Win/i.test(navigator.platform || navigator.userAgent)
  return windows ? `taskkill /PID ${pid} /T /F` : `kill ${pid}`
}

const KIND_ORDER: FlagKind[] =["risky", "secret_value", "secret_file", "outbound", "background"]
const SERIOUS = new Set<FlagKind>(["risky", "secret_value"])

export function Review({ session }: { session: Session }) {
  const { t } = useI18n()
  const { counts, total, items, more, ignored } = session.review
  if (!total) return null

  const summary = KIND_ORDER.filter(kind => counts[kind]).map(kind => (
    <Badge key={kind} variant="outline" className={cn(SERIOUS.has(kind) && "border-stuck/50 text-stuck")}>
      {t(`review.count.${kind}`, { n: counts[kind] })}
    </Badge>
  ))

  return (
    <Section title={t("review.title")} summary={summary}>
      <ol className="space-y-4">
        {items.map(item => (
          <li key={`${item.rule}|${item.host ?? ""}`} className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className={cn("inline-flex items-center gap-1.5 font-medium", SERIOUS.has(item.kind) && "text-stuck")}>
                {SERIOUS.has(item.kind) && <ShieldAlertIcon className="size-3.5" aria-hidden />}
                {t(`rule.${item.rule}`, { host: item.host ?? "" })}
              </span>
              {item.count > 1 && <span className="tabular-nums text-muted-foreground">×{item.count}</span>}
              {(["refused", "asked", "rule"] as const)
                .filter(how => item.approvals[how])
                .map(how => (
                  <span key={how} className={cn("text-muted-foreground", how === "refused" && "text-finished")}>
                    {t(`approval.${how}`)}
                    {item.count > 1 && ` ×${item.approvals[how]}`}
                  </span>
                ))}
            </div>
            <ul className="space-y-1 border-l-2 border-border pl-3">
              {item.examples.map(example => (
                <li key={example.text} className="space-y-0.5">
                  <Code>{example.text}</Code>
                  {(item.examples.length > 1 || example.count > 1) && (
                    <p className="text-xs text-muted-foreground">
                      {example.count > 1 && `×${example.count} · `}
                      {(["refused", "asked", "rule"] as const).filter(k => example.approvals[k]).map(k => t(`approval.${k}`)).join(" / ")}
                    </p>
                  )}
                </li>
              ))}
            </ul>
            {item.hiddenExamples > 0 && <p className="text-stuck">{t("review.hiddenExamples", { n: item.hiddenExamples })}</p>}
          </li>
        ))}
      </ol>
      {more > 0 && <p className="text-stuck">{t("review.more", { n: more })}</p>}
      {ignored > 0 && <p className="text-muted-foreground">{t("review.ignored", { n: ignored })}</p>}
      <p className="text-xs text-muted-foreground">{t("review.note")}</p>
    </Section>
  )
}
