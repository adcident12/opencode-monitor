"use client"

import { ChartColumnIcon, HistoryIcon, RadioIcon, SettingsIcon } from "lucide-react"
import { useEffect } from "react"
import { UpdateBanner } from "@/components/monitor/update-banner"
import { Environment } from "@/components/monitor/environment"
import { Header } from "@/components/monitor/header"
import { useTabIcon } from "@/components/monitor/logo"
import type { MarkTone } from "@/lib/logo"
import { History } from "@/components/monitor/history"
import { AttentionCard, QuietRow, WorkingCard } from "@/components/monitor/sessions"
import { TAB as TAB_SPACE } from "@/components/monitor/section"
import { Setup } from "@/components/monitor/setup"
import { Stats } from "@/components/monitor/stats"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { childrenOf, groupByUrgency } from "@/lib/format"
import { useI18n } from "@/lib/i18n"
import { cn } from "@/lib/utils"
import { useHash, useNow, useSnapshot } from "@/lib/live"

type Tab = "now" | "history" | "stats" | "setup"

// On a phone four labels with icons do not fit: the icons go first, the labels stay.
const TAB = "flex-none gap-2 px-2.5 text-sm text-foreground/75 data-active:text-foreground sm:px-3.5 [&_svg]:hidden sm:[&_svg]:block"

export default function Page() {
  const { t } = useI18n()
  const { snapshot, connected, skew } = useSnapshot()
  const now = useNow(skew)
  const [hash, setHash] = useHash()
  // #stats or #history, optionally narrowed to one session: #stats/<session id>.
  const [, hashTab, hashSession] = /^#(history|stats|setup)(?:\/([A-Za-z0-9_-]+))?$/.exec(hash) ?? []
  const tab: Tab = (hashTab as Tab | undefined) ?? "now"
  const session = hashSession ?? null
  const changeTab = (value: Tab) => setHash(value === "now" ? "" : value)
  const changeSession = (id: string | null) => setHash(id ? `${tab}/${id}` : tab)

  const historyEnabled = snapshot?.historyCount != null
  const sessions = snapshot?.sessions ?? []
  const { attention, working, rest } = groupByUrgency(sessions)

  // One word for everything on screen: the most urgent state there is.
  const tone: MarkTone = attention.length ? (attention[0].state as MarkTone) : working.length ? "working" : "quiet"
  useTabIcon(tone)

  // The tab title carries the count, so it can be read from another tab or the taskbar.
  useEffect(() => {
    document.title = `${attention.length ? `(${attention.length}) ` : ""}${t("app.title")}`
  }, [attention.length, t])

  return (
    <div className="mx-auto max-w-5xl space-y-6 px-4 pt-6 pb-16 sm:px-6 sm:pt-8">
      <UpdateBanner served={snapshot?.build ?? null} />
      <Header snapshot={snapshot} connected={connected} tone={tone} />
      {snapshot?.opencodeUntested && (
        <output className="block rounded-lg bg-waiting-soft/60 px-3.5 py-2.5 text-sm text-waiting">
          {t("oc.untested", { version: snapshot.opencodeVersion ?? "", tested: snapshot.opencodeTested ?? "" })}
        </output>
      )}
      <Environment environment={snapshot?.environment ?? null} />

      <Tabs value={tab} onValueChange={value => changeTab(value as Tab)} className="gap-6">
        {/* Full-contrast labels with icons, so the other views are seen at a glance. */}
        <TabsList className="h-10 max-w-full gap-1 overflow-x-auto p-1">
          <TabsTrigger value="now" className={TAB}>
            <RadioIcon aria-hidden />
            {t("tab.now")}
            {/* From another tab, still show that something needs you. */}
            {tab !== "now" && attention.length > 0 && <span className="rounded-full bg-waiting px-1.5 text-xs font-semibold tabular-nums text-background">{attention.length}</span>}
          </TabsTrigger>
          {historyEnabled && (
            <TabsTrigger value="history" className={TAB}>
              <HistoryIcon aria-hidden />
              {t("tab.history")}
            </TabsTrigger>
          )}
          <TabsTrigger value="stats" className={TAB}>
            <ChartColumnIcon aria-hidden />
            {t("tab.stats")}
          </TabsTrigger>
          <TabsTrigger value="setup" className={TAB}>
            <SettingsIcon aria-hidden />
            {t("tab.setup")}
            {/* Something on this machine is missing: say so from any tab. */}
            {tab !== "setup" && snapshot?.opencodeUntested && <span className="size-1.5 rounded-full bg-waiting" aria-hidden />}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="now" className={TAB_SPACE}>
          {!snapshot && <Loading />}

          {snapshot && (
            <section aria-labelledby="attention-heading" className="space-y-4">
              <h2 id="attention-heading" className="text-2xl font-semibold">
                {attention.length ? t("summary.attention", { n: attention.length }) : t("summary.none")}
              </h2>
              {attention.map(s => (
                <AttentionCard key={s.id} session={s} subagents={childrenOf(sessions, s.id)} now={now} history={historyEnabled} />
              ))}
            </section>
          )}

          {working.length > 0 && (
            <section aria-labelledby="working-heading" className="space-y-3">
              <h2 id="working-heading" className="text-sm font-medium text-muted-foreground">
                {t("section.working", { n: working.length })}
              </h2>
              <div className={cn("grid grid-cols-[minmax(0,1fr)] gap-4", working.length > 1 && "lg:grid-cols-2")}>
                {working.map(s => (
                  <WorkingCard key={s.id} session={s} subagents={childrenOf(sessions, s.id)} now={now} history={historyEnabled} />
                ))}
              </div>
            </section>
          )}

          {rest.length > 0 && (
            <section aria-labelledby="rest-heading" className="space-y-3">
              <h2 id="rest-heading" className="text-sm font-medium text-muted-foreground">
                {t("section.rest", { n: rest.length })}
              </h2>
              <ul className="divide-y rounded-xl border bg-card">
                {rest.map(s => (
                  <QuietRow key={s.id} session={s} now={now} history={historyEnabled} />
                ))}
              </ul>
            </section>
          )}

          {snapshot && !sessions.length && (
            <div className="rounded-xl border border-dashed px-6 py-14 text-center">
              <p className="font-medium">{t("empty.title")}</p>
              <p className="mt-1 text-sm text-muted-foreground">{t("empty.body", { h: snapshot.lookbackHours })}</p>
            </div>
          )}
        </TabsContent>

        {historyEnabled && (
          <TabsContent value="history">
            <History count={snapshot?.historyCount ?? null} active={tab === "history"} session={session} onSession={changeSession} />
          </TabsContent>
        )}

        <TabsContent value="setup">{tab === "setup" && <Setup active />}</TabsContent>

        <TabsContent value="stats">{tab === "stats" && <Stats session={session} onSession={changeSession} />}</TabsContent>
      </Tabs>
    </div>
  )
}

function Loading() {
  return (
    <div className="space-y-4" aria-hidden>
      <Skeleton className="h-8 w-56" />
      <Skeleton className="h-44 w-full rounded-xl" />
      <Skeleton className="h-28 w-full rounded-xl" />
    </div>
  )
}
