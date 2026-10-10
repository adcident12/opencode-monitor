"use client"

import { useEffect } from "react"
import { markDataUrl, RING, type MarkTone } from "@/lib/logo"
import { cn } from "@/lib/utils"

const DOT: Record<MarkTone, string> = {
  waiting: "fill-waiting",
  stuck: "fill-stuck",
  error: "fill-error",
  working: "fill-working",
  quiet: "fill-idle",
}

/**
 * The mark beside the title. Drawn with the page's own colours, so it follows the theme;
 * the dot shows what your sessions are doing, the same as the icon in the browser tab.
 */
export function Logo({ tone, className }: { tone: MarkTone; className?: string }) {
  return (
    <svg viewBox="3.5 3.5 25 25" aria-hidden className={cn("size-7 shrink-0", className)}>
      <circle className="stroke-foreground" cx={RING.cx} cy={RING.cy} r={RING.r} fill="none" strokeWidth={RING.strokeWidth} strokeLinecap="round" strokeDasharray={RING.dash} transform={RING.rotate} />
      <circle className={cn(DOT[tone], tone !== "quiet" && "animate-breathe")} cx="16" cy="16" r="4.2" />
    </svg>
  )
}

/**
 * Keeps the browser tab's icon in step with the sessions: amber when something waits for
 * you, blue while the agent works. From another tab, the icon alone says whether to look.
 */
export function useTabIcon(tone: MarkTone) {
  useEffect(() => {
    // Our own element, added after the static icons: the browser uses the last one that fits.
    let link = document.querySelector<HTMLLinkElement>('link[data-live-icon]')
    if (!link) {
      link = document.createElement("link")
      link.rel = "icon"
      link.type = "image/svg+xml"
      link.dataset.liveIcon = ""
      document.head.appendChild(link)
    }
    link.href = markDataUrl(tone)
  }, [tone])
}
