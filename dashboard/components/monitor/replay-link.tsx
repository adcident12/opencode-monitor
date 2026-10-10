"use client"

import { RotateCcwIcon } from "lucide-react"
import { useI18n } from "@/lib/i18n"

/** Plays this session back in the Replay tab. */
export function ReplayLink({ id }: Readonly<{ id: string }>) {
  const { t } = useI18n()
  return (
    <a
      href={`#replay/${id}`}
      className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-sm text-muted-foreground underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
    >
      <RotateCcwIcon aria-hidden className="size-3.5" />
      {t("links.replayThis")}
    </a>
  )
}
