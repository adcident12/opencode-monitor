"use client"

import { cloneElement, useState, type ReactElement, type ReactNode } from "react"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

/**
 * The look of every hover card on the page, the charts' included, so that a tooltip looks
 * the same wherever it opens: shadcn's tooltip, from components/ui/tooltip.
 */
export const TIP = "rounded-md bg-foreground px-3 py-1.5 text-xs text-background shadow-md"

const isCut = (el: HTMLElement | null) => el != null && (el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight + 1)

/**
 * Text, or a control, with a tooltip: the page's own, never the browser's `title`.
 *
 * @param render     the element to put it on; a plain span by default. Give a button to
 *                   tooltip a button: it stays the one element, with its own role and keys.
 * @param onlyWhenCut open only when the text does not fit and is cut short with "…": a
 *                   tooltip that repeats what is already in full on screen is noise.
 */
export function Hint({ label, children, className, render, onlyWhenCut = false }: Readonly<{
  label: ReactNode
  children: ReactNode
  className?: string
  render?: ReactElement
  onlyWhenCut?: boolean
}>) {
  // The element itself, kept to measure whether its text was cut short.
  const [el, setEl] = useState<HTMLElement | null>(null)
  const [open, setOpen] = useState(false)
  const element = cloneElement((render ?? <span />) as ReactElement<{ ref?: unknown }>, { ref: setEl })
  return (
    <Tooltip open={open} onOpenChange={next => setOpen(next && (!onlyWhenCut || isCut(el)))}>
      <TooltipTrigger render={element} className={className}>
        {children}
      </TooltipTrigger>
      {/* Paths and names have no spaces to break at: let them break anywhere. */}
      <TooltipContent className="[overflow-wrap:anywhere]">{label}</TooltipContent>
    </Tooltip>
  )
}
