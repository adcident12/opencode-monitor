"use client"

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useI18n } from "@/lib/i18n"
import type { CheckedTarget, Snapshot } from "@/lib/types"
import { cn } from "@/lib/utils"
import { Dot, toneOf } from "./state"

// One line under the header: what the agent depends on, each with a dot and a short note.
// "disabled" servers are not listed; the entry is here so that every status has a tone.
const MCP_TONE = { failed: "bad", ok: "ok", unknown: "unknown", disabled: "unknown" } as const

export function Environment({ environment }: Readonly<{ environment: Snapshot["environment"] }>) {
  const { t } = useI18n()
  if (!environment) return null

  const checkedNote = (item: CheckedTarget) => {
    if (item.ok == null) return "…"
    return item.ok ? `${item.ms} ms` : t(`env.${item.error ?? "error"}`, { status: item.status ?? "" })
  }
  const checked = (item: CheckedTarget) => ({
    key: item.name,
    name: item.name,
    tone: toneOf(item.ok),
    note: checkedNote(item),
    tip: item.target,
  })
  const mcpNote = (m: NonNullable<Snapshot["environment"]>["mcp"][number]) => {
    if (m.status === "failed") return t(`env.mcp.${m.kind}`)
    return m.status === "ok" ? "" : t("env.mcp.unknown")
  }

  const groups = [
    { label: t("env.model"), items: environment.models.map(checked) },
    {
      label: t("env.mcp"),
      items: environment.mcp
        .filter(m => m.status !== "disabled")
        .map(m => ({
          key: m.name,
          name: m.name,
          tone: MCP_TONE[m.status],
          note: mcpNote(m),
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
