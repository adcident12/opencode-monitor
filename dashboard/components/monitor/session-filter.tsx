"use client"

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useI18n } from "@/lib/i18n"
import type { SessionChoice } from "@/lib/types"

const ALL = "all"

/** Narrows a view to one session. The current choice stays listed even if the list no longer has it. */
export function SessionFilter({ value, onChange, sessions, current, allowAll = true }: Readonly<{ value: string | null; onChange: (id: string | null) => void; sessions: SessionChoice[]; current?: SessionChoice | null; allowAll?: boolean }>) {
  const { t } = useI18n()
  const listed = current && !sessions.some(s => s.id === current.id) ? [current, ...sessions] : sessions
  const label = (s: SessionChoice) => `${s.project ? `${s.project} · ` : ""}${s.title || s.id}`
  const items = [...(allowAll ? [{ value: ALL, label: t("filter.allSessions") }] : []), ...listed.map(s => ({ value: s.id, label: label(s) }))]

  return (
    <Select value={value ?? ALL} onValueChange={next => onChange(!next || next === ALL ? null : String(next))} items={items}>
      <SelectTrigger size="sm" aria-label={t("filter.session")} className="max-w-full min-w-44 sm:max-w-80">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {items.map(item => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
