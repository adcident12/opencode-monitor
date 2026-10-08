"use client"

import { useEffect } from "react"
import { Environment } from "@/components/monitor/environment"
import { Header } from "@/components/monitor/header"
import { History } from "@/components/monitor/history"
import { AttentionCard, QuietRow, WorkingCard } from "@/components/monitor/sessions"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { childrenOf, groupByUrgency } from "@/lib/format"
import { useI18n } from "@/lib/i18n"
import { useHash, useHistory, useNow, useSnapshot } from "@/lib/live"

type Tab = "now" | "history"

export default function Page() {
  const { t } = useI18n()
  const { snapshot, connected, skew } = useSnapshot()
  const now = useNow(skew)
  const [hash, setHash] = useHash()
  const tab: Tab = hash === "#history" ? "history" : "now"
  const changeTab = (value: Tab) => setHash(value === "history" ? "history" : "")

  const historyEnabled = snapshot?.historyCount != null
  const events = useHistory(snapshot?.historyCount ?? null, tab === "history")
  const sessions = snapshot?.sessions ?? []
  const { attention, working, rest } = groupByUrgency(sessions)

  // The tab title carries the count, so it can be read from another tab or the taskbar.
  useEffect(() => {
    document.title = `${attention.length ? `(${attention.length}) ` : ""}${t("app.title")}`
  }, [attention.length, t])

  return (
    <div className="mx-auto max-w-5xl space-y-6 px-4 pt-6 pb-16 sm:px-6 sm:pt-8">
      <Header snapshot={snapshot} connected={connected} />
      <Environment environment={snapshot?.environment ?? null} />

      <Tabs value={tab} onValueChange={value => changeTab(value as Tab)} className="gap-6">
        {historyEnabled && (
          <TabsList variant="line">
            <TabsTrigger value="now">{t("tab.now")}</TabsTrigger>
            <TabsTrigger value="history">{t("tab.history")}</TabsTrigger>
          </TabsList>
        )}

        <TabsContent value="now" className="space-y-10">
          {!snapshot && <Loading />}

          {snapshot && (
            <section aria-labelledby="attention-heading" className="space-y-4">
              <h2 id="attention-heading" className="text-2xl font-semibold tracking-tight sm:text-[1.7rem]">
                {attention.length ? t("summary.attention", { n: attention.length }) : t("summary.none")}
              </h2>
              {attention.map(s => (
                <AttentionCard key={s.id} session={s} subagents={childrenOf(sessions, s.id)} now={now} />
              ))}
            </section>
          )}

          {working.length > 0 && (
            <section aria-labelledby="working-heading" className="space-y-3">
              <h2 id="working-heading" className="text-sm font-medium text-muted-foreground">
                {t("section.working", { n: working.length })}
              </h2>
              <div className="grid gap-3 lg:grid-cols-2">
                {working.map(s => (
                  <WorkingCard key={s.id} session={s} subagents={childrenOf(sessions, s.id)} now={now} />
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
                  <QuietRow key={s.id} session={s} now={now} />
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
            <History events={events} />
          </TabsContent>
        )}
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
