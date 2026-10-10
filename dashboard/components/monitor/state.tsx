import { CircleCheckIcon, CircleDashedIcon, CircleXIcon, HandIcon, HourglassIcon, LoaderIcon, type LucideIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import type { State } from "@/lib/types"

// Every state has its own colour and its own icon shape, so colour is never the only signal.
// Class names are spelled out in full for Tailwind to find them.
export const STATE_STYLE: Record<State, { icon: LucideIcon; text: string; soft: string; bar: string; ring: string }> = {
  waiting: { icon: HandIcon, text: "text-waiting", soft: "bg-waiting-soft", bar: "bg-waiting", ring: "ring-waiting/40" },
  stuck: { icon: HourglassIcon, text: "text-stuck", soft: "bg-stuck-soft", bar: "bg-stuck", ring: "ring-stuck/40" },
  error: { icon: CircleXIcon, text: "text-error", soft: "bg-error-soft", bar: "bg-error", ring: "ring-error/40" },
  working: { icon: LoaderIcon, text: "text-working", soft: "bg-working-soft", bar: "bg-working", ring: "ring-working/30" },
  finished: { icon: CircleCheckIcon, text: "text-finished", soft: "bg-finished-soft", bar: "bg-finished", ring: "ring-finished/30" },
  idle: { icon: CircleDashedIcon, text: "text-idle", soft: "bg-idle-soft", bar: "bg-idle", ring: "ring-idle/30" },
}

export function StateBadge({ state, label, className }: Readonly<{ state: State; label: string; className?: string }>) {
  const { icon: Icon, text, soft } = STATE_STYLE[state]
  return (
    <Badge variant="outline" className={cn("h-6 gap-1.5 border-transparent px-2.5 text-code font-medium", soft, text, className)}>
      <Icon className={cn(state === "working" && "animate-breathe")} aria-hidden />
      {label}
    </Badge>
  )
}

/** Yes, no, or not known yet, as the tone of a dot. */
export function toneOf(ok: boolean | null | undefined): "ok" | "bad" | "unknown" {
  if (ok == null) return "unknown"
  return ok ? "ok" : "bad"
}

/** A single coloured dot with a tooltip-free text label next to it, for compact chips. */
export function Dot({ tone }: Readonly<{ tone: "ok" | "bad" | "unknown" }>) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block size-2 shrink-0 rounded-full",
        tone === "ok" && "bg-finished",
        tone === "bad" && "bg-error",
        tone === "unknown" && "bg-idle/60",
      )}
    />
  )
}
