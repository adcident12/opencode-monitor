"use client"

import { Skeleton } from "@/components/ui/skeleton"
import { compact } from "@/lib/format"
import { useI18n } from "@/lib/i18n"
import { useSetup } from "@/lib/live"
import type { SetupReport } from "@/lib/types"
import { cn } from "@/lib/utils"
import { Chapter, H3, TAB, TH } from "./section"
import { Dot } from "./state"

/**
 * What the monitor found on this machine. Every other tab is built from these: when one of
 * them shows less than expected, the reason is here, next to what to do about it.
 */
export function Setup({ active }: { active: boolean }) {
  const { t } = useI18n()
  const { report, failed } = useSetup(active)

  if (failed && !report) return <p className="text-sm text-error">{t("setup.failed")}</p>
  if (!report) return <Skeleton className="h-64 w-full" />

  return (
    <div className={TAB}>
      <Problems report={report} />

      <Section id="setup-opencode" title={t("setup.opencode")}>
        <Row file label={t("setup.database")} ok={report.opencode.database.found} value={<Path>{report.opencode.database.path}</Path>} />
        <Row file label={t("setup.log")} ok={report.opencode.log.found} value={<Path>{report.opencode.log.path}</Path>} />
        <Row
          file
          label={t("setup.opencodeConfig")}
          ok={report.opencode.configFiles.length > 0}
          value={
            <>
              <Path>{report.opencode.configDir}</Path>
              {report.opencode.configFiles.length > 0 && <span className="block text-xs text-muted-foreground">{report.opencode.configFiles.join(", ")}</span>}
            </>
          }
        />
        <Row label={t("setup.opencodeVersion")} value={`${report.opencode.version ?? "?"} · ${t("setup.testedWith", { v: report.opencode.tested })}`} />
      </Section>

      <Section id="setup-models" title={t("setup.models")} note={t("setup.modelsNote")}>
        {report.models.length === 0 && <p className="py-2 text-sm text-muted-foreground">{t("setup.noModels")}</p>}
        {report.models.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b">
                  <th scope="col" className={TH}>{t("stats.speedModel")}</th>
                  <th scope="col" className={cn(TH, "text-right")}>{t("setup.context")}</th>
                  <th scope="col" className={cn(TH, "text-right")}>{t("setup.output")}</th>
                  <th scope="col" className={cn(TH, "text-right")}>{t("setup.compactAt")}</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {report.models.map(m => (
                  <tr key={m.id}>
                    <th scope="row" className="py-2 pr-3 text-left font-normal">
                      <span className="font-mono text-code [overflow-wrap:anywhere]">{m.id}</span>
                      <span className="block text-xs text-muted-foreground">
                        {t("stats.speedRequests", { n: m.requests })}
                        {m.source === "monitor" && <> · {t("setup.fromMonitor")}</>}
                      </span>
                    </th>
                    <td className={cn("py-2 pr-3 text-right tabular-nums whitespace-nowrap", m.context == null && "text-waiting")}>{m.context == null ? t("setup.limitUnknown") : compact(m.context)}</td>
                    <td className="py-2 pr-3 text-right tabular-nums text-muted-foreground">{m.output == null ? "–" : compact(m.output)}</td>
                    <td className="py-2 text-right font-medium tabular-nums">{m.compactAt == null ? "–" : compact(m.compactAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="pt-2 text-xs text-muted-foreground">
          {t(report.compaction.auto ? "setup.compactionOn" : "setup.compactionOffNote")}
          {report.compaction.reserved != null && <> {t("setup.compactionReservedNote", { n: report.compaction.reserved })}</>}
          {report.compaction.outputTokenMax != null && <> {t("setup.outputTokenMaxNote", { n: report.compaction.outputTokenMax })}</>}
        </p>
      </Section>

      <Section id="setup-notify" title={t("setup.notify")}>
        <Row label={t("setup.desktop")} ok={report.notify.desktop} value={t(report.notify.desktop ? "setup.yes" : "setup.no")} />
        <Row label={t("setup.discord")} ok={report.notify.discord} value={t(report.notify.discord ? "setup.discordSet" : "setup.no")} />
        <Row label={t("setup.notifyOn")} value={report.notify.on.length ? report.notify.on.map(s => t(`setup.on.${s}`)).join(", ") : t("setup.none")} />
      </Section>
      <Sent report={report} />

      <Section id="setup-monitor" title={t("setup.monitor")}>
        <Row label={t("setup.version")} value={report.monitor.version ?? "?"} />
        <Row label={t("setup.configFile")} ok={report.monitor.configFile?.found ?? false} value={<Path>{report.monitor.configFile?.path ?? ""}</Path>} note={report.monitor.configFile?.found ? undefined : t("setup.configDefaults")} />
        <Row
          label={t("setup.historyFile")}
          value={report.history.enabled ? <Path>{report.history.file}</Path> : t("setup.no")}
          note={report.history.enabled ? t("setup.keptDays", { n: report.history.retentionDays }) : undefined}
        />
        <Row label={t("setup.mcp")} value={report.mcp.length ? report.mcp.map(s => `${s.name}${s.enabled ? "" : ` (${t("stats.mcpOff")})`}`).join(", ") : t("setup.none")} />
      </Section>
    </div>
  )
}

/**
 * What was actually sent, and whether each channel took it. Without this there is no way to
 * tell "nothing happened that needed a notification" from "it was sent and got lost".
 */
function Sent({ report }: { report: SetupReport }) {
  const { t, lang } = useI18n()
  const when = new Intl.DateTimeFormat(lang, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
  const outcome = (text: string) => {
    if (text === "sent") return <span className="text-finished">{t("setup.sent")}</span>
    if (text === "off") return <span className="text-muted-foreground">{t("setup.no")}</span>
    if (text === "sending") return <span className="text-muted-foreground">{t("setup.sending")}</span>
    return <span className="font-medium text-error">{text}</span>
  }
  return (
    <div className="space-y-2">
      <div>
        <h3 className={H3}>{t("setup.recent")}</h3>
        <p className="mt-0.5 max-w-prose text-xs text-muted-foreground">{t("setup.recentNote")}</p>
      </div>
      {report.notify.recent.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("setup.recentNone")}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b">
                <th scope="col" className={TH}>{t("setup.recentWhen")}</th>
                <th scope="col" className={TH}>{t("setup.recentWhat")}</th>
                <th scope="col" className={TH}>{t("setup.desktop")}</th>
                <th scope="col" className={TH}>{t("setup.discord")}</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {report.notify.recent.map((n, i) => (
                <tr key={`${n.t}-${i}`}>
                  <td className="py-2 pr-3 text-xs tabular-nums whitespace-nowrap text-muted-foreground">{when.format(n.t)}</td>
                  <th scope="row" className="py-2 pr-3 text-left font-normal">
                    {n.title}
                    <span className="block text-xs text-muted-foreground [overflow-wrap:anywhere]">{n.subject}</span>
                  </th>
                  <td className="py-2 pr-3 whitespace-nowrap">{outcome(n.desktop)}</td>
                  <td className="py-2 whitespace-nowrap">{outcome(n.discord)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

/** What is missing, first: each with what it costs you and what to do. */
function Problems({ report }: { report: SetupReport }) {
  const { t } = useI18n()
  if (!report.problems.length) {
    return (
      <p className="flex items-center gap-2.5 rounded-lg bg-finished-soft/60 px-3.5 py-2.5 text-sm text-finished">
        <Dot tone="ok" />
        {t("setup.noProblems")}
      </p>
    )
  }
  return (
    <Chapter id="setup-problems" first title={t("setup.problems")}>
      <ul className="divide-y rounded-xl border bg-card">
        {report.problems.map(p => (
          <li key={`${p.code}-${p.subject ?? ""}`} className="space-y-1 px-4 py-3">
            <p className="text-sm font-medium text-waiting">{t(`setup.problem.${p.code}`, { subject: p.subject ?? "" })}</p>
            <p className="max-w-prose text-sm text-muted-foreground">{t(`setup.fix.${p.code}`, { subject: p.subject ?? "" })}</p>
          </li>
        ))}
      </ul>
    </Chapter>
  )
}

/** A chapter whose content is a list of label and value rows, plus whatever follows them. */
function Section({ id, title, note, children }: { id: string; title: string; note?: string; children: React.ReactNode }) {
  return (
    <Chapter id={id} title={title} note={note}>
      <div className="divide-y">{children}</div>
    </Chapter>
  )
}

/** @param file  the row is about a file: say "not found" when it is missing, not just "off" */
function Row({ label, value, ok, note, file = false }: { label: string; value: React.ReactNode; ok?: boolean; note?: string; file?: boolean }) {
  const { t } = useI18n()
  return (
    <dl className="grid grid-cols-[minmax(0,1fr)] gap-x-6 gap-y-0.5 py-2.5 text-sm sm:grid-cols-[14rem_minmax(0,1fr)]">
      <dt className="flex items-center gap-2 text-muted-foreground">
        {ok != null && <Dot tone={ok ? "ok" : "unknown"} />}
        {label}
      </dt>
      <dd className="min-w-0">
        {value}
        {file && ok === false && <span className="ml-2 text-xs text-waiting">{t("setup.notFound")}</span>}
        {note && <span className="block text-xs text-muted-foreground">{note}</span>}
      </dd>
    </dl>
  )
}

function Path({ children }: { children: string }) {
  return <span className="font-mono text-code [overflow-wrap:anywhere]">{children}</span>
}
