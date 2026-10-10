"use client"

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useI18n } from "@/lib/i18n"
import type { CheckedTarget, Snapshot } from "@/lib/types"
import { cn } from "@/lib/utils"
import { Dot } from "./state"

// One line under the header: what the agent depends on, each with a dot and a short note.
export function Environment({ environment }: { environment: Snapshot["environment"] }) {
  const { t } = useI18n()
  if (!environment) return null

  const checked = (item: CheckedTarget) => ({
    key: item.name,
    name: item.name,
    tone: item.ok == null ? ("unknown" as const) : item.ok ? ("ok" as const) : ("bad" as const),
    note: item.ok == null ? "…" : item.ok ? `${item.ms} ms` : t(`env.${item.error ?? "error"}`, { status: item.status ?? "" }),
    tip: item.target,
  })

  const groups = [
    { label: t("env.model"), items: environment.models.map(checked) },
    {
      label: t("env.mcp"),
      items: environment.mcp
        .filter(m => m.status !== "disabled")
        .map(m => ({
          key: m.name,
          name: m.name,
          tone: m.status === "failed" ? ("bad" as const) : m.status === "ok" ? ("ok" as const) : ("unknown" as const),
          note: m.status === "failed" ? t(`env.mcp.${m.kind}`) : m.status === "ok" ? "" : t("env.mcp.unknown"),
          tip: t(`env.mcp.tip.${m.status}`),
        })),
    },
    { label: t("env.services"), items: environment.services.map(checked) },
  ].filter(group => group.items.length)

  if (!groups.length) return null

  return (
    <section aria-label={t("env.title")} className="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-5 gap-y-2 border-y border-border/70 py-3 text-sm">
      {groups.map(group => (
        <div key={group.label} className="contents">
          <span className="text-muted-foreground">{group.label}</span>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5">
          {group.items.map(item => (
            <Tooltip key={item.key}>
              <TooltipTrigger render={<span tabIndex={0} />} className="inline-flex items-center gap-1.5 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <Dot tone={item.tone} />
                <span className={cn(item.tone === "bad" && "font-medium text-error")}>{item.name}</span>
                {item.note && <span className="text-muted-foreground">{item.note}</span>}
              </TooltipTrigger>
              {item.tip && <TooltipContent className="max-w-72">{item.tip}</TooltipContent>}
            </Tooltip>
          ))}
          </div>
        </div>
      ))}
    </section>
  )
}
