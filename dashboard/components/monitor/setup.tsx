"use client"

import { Skeleton } from "@/components/ui/skeleton"
import { compact } from "@/lib/format"
import { useI18n } from "@/lib/i18n"
import { useSetup } from "@/lib/live"
import type { SetupReport } from "@/lib/types"
import { cn } from "@/lib/utils"
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
    <div className="space-y-8">
      <Problems report={report} />

      <Section title={t("setup.opencode")}>
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

      <Section title={t("setup.models")} note={t("setup.modelsNote")}>
        {report.models.length === 0 && <p className="py-2 text-sm text-muted-foreground">{t("setup.noModels")}</p>}
        {report.models.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th scope="col" className="py-1.5 pr-3 font-normal">{t("stats.speedModel")}</th>
                  <th scope="col" className="py-1.5 pr-3 text-right font-normal">{t("setup.context")}</th>
                  <th scope="col" className="py-1.5 pr-3 text-right font-normal">{t("setup.output")}</th>
                  <th scope="col" className="py-1.5 text-right font-normal">{t("setup.compactAt")}</th>
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

      <Section title={t("setup.notify")}>
        <Row label={t("setup.desktop")} ok={report.notify.desktop} value={t(report.notify.desktop ? "setup.yes" : "setup.no")} />
        <Row label={t("setup.discord")} ok={report.notify.discord} value={t(report.notify.discord ? "setup.discordSet" : "setup.no")} />
        <Row label={t("setup.notifyOn")} value={report.notify.on.length ? report.notify.on.map(s => t(`setup.on.${s}`)).join(", ") : t("setup.none")} />
      </Section>

      <Section title={t("setup.monitor")}>
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
    <section aria-labelledby="setup-problems" className="space-y-2">
      <h2 id="setup-problems" className="text-xl font-semibold">
        {t("setup.problems")}
      </h2>
      <ul className="divide-y rounded-xl border bg-card">
        {report.problems.map(p => (
          <li key={`${p.code}-${p.subject ?? ""}`} className="space-y-1 px-4 py-3">
            <p className="text-sm font-medium text-waiting">{t(`setup.problem.${p.code}`, { subject: p.subject ?? "" })}</p>
            <p className="max-w-prose text-sm text-muted-foreground">{t(`setup.fix.${p.code}`, { subject: p.subject ?? "" })}</p>
          </li>
        ))}
      </ul>
    </section>
  )
}

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2 border-t pt-6">
      <div>
        <h2 className="text-xl font-semibold">{title}</h2>
        {note && <p className="mt-1 max-w-prose text-sm text-muted-foreground">{note}</p>}
      </div>
      <dl className="divide-y">{children}</dl>
    </section>
  )
}

/** @param file  the row is about a file: say "not found" when it is missing, not just "off" */
function Row({ label, value, ok, note, file = false }: { label: string; value: React.ReactNode; ok?: boolean; note?: string; file?: boolean }) {
  const { t } = useI18n()
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-x-6 gap-y-0.5 py-2.5 text-sm sm:grid-cols-[14rem_minmax(0,1fr)]">
      <dt className="flex items-center gap-2 text-muted-foreground">
        {ok != null && <Dot tone={ok ? "ok" : "unknown"} />}
        {label}
      </dt>
      <dd className="min-w-0">
        {value}
        {file && ok === false && <span className="ml-2 text-xs text-waiting">{t("setup.notFound")}</span>}
        {note && <span className="block text-xs text-muted-foreground">{note}</span>}
      </dd>
    </div>
  )
}

function Path({ children }: { children: string }) {
  return <span className="font-mono text-code [overflow-wrap:anywhere]">{children}</span>
}
