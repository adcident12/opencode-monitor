"use client"

import { cn } from "@/lib/utils"

// The one place the page's rhythm is defined. Every tab is a column of chapters; a chapter
// has a heading, an optional line under it, and its content. Tabs must not set their own
// heading sizes or the space between chapters: that is how they drifted apart before.

/** Space between the top-level blocks of a tab. */
export const TAB = "space-y-8"

/** A heading inside a chapter. */
export const H3 = "text-base font-semibold"

/** A section inside a chapter: its heading, then its content, 12px apart. */
export const SUB = "space-y-3"

/** Sections inside a chapter sit 32px apart, the same as the gap of a two-column grid of them. */
export const GRID = "grid grid-cols-[minmax(0,1fr)] gap-x-10 gap-y-8 lg:grid-cols-2"

/**
 * A few labelled figures side by side. Each label sits on top and its value at the bottom of
 * the row, so a label that wraps onto two lines does not push its value below its neighbours'.
 */
export function Facts({ items, className }: { items: { key: string; label: React.ReactNode; value: React.ReactNode; wide?: boolean; tone?: string }[]; className?: string }) {
  return (
    <dl className={cn("grid gap-x-6 gap-y-3", className)}>
      {items.map(item => (
        <div key={item.key} className={cn("flex flex-col gap-0.5", item.wide && "col-span-2")}>
          <dt className="text-xs text-muted-foreground">{item.label}</dt>
          <dd className={cn("mt-auto text-sm font-medium tabular-nums", item.tone)}>{item.value}</dd>
        </div>
      ))}
    </dl>
  )
}

/** Table cells: one padding and one size for every table on the page. */
export const TH = "py-1.5 pr-3 text-left text-xs font-normal text-muted-foreground last:pr-0"
export const TD = "py-2 pr-3 last:pr-0"

/**
 * @param first   the first chapter of a tab has no rule above it
 * @param action  a control that belongs to the whole chapter, shown beside the heading
 */
export function Chapter({ id, title, note, action, first = false, children }: { id: string; title: string; note?: string; action?: React.ReactNode; first?: boolean; children: React.ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className={cn("scroll-mt-6 space-y-8", !first && "border-t pt-8")}>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="space-y-1">
          <h2 id={`${id}-title`} className="text-xl font-semibold">
            {title}
          </h2>
          {note && <p className="max-w-prose text-sm text-muted-foreground">{note}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  )
}
