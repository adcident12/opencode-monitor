"use client"

import { cn } from "@/lib/utils"

// The one place the page's rhythm is defined. Every tab is a column of chapters; a chapter
// has a heading, an optional line under it, and its content. Tabs must not set their own
// heading sizes or the space between chapters: that is how they drifted apart before.

/** Space between the top-level blocks of a tab. */
export const TAB = "space-y-8"

/** A heading inside a chapter. */
export const H3 = "text-base font-semibold"

/** Table cells: one padding and one size for every table on the page. */
export const TH = "py-1.5 pr-3 text-left text-xs font-normal text-muted-foreground last:pr-0"
export const TD = "py-2 pr-3 last:pr-0"

/**
 * @param first   the first chapter of a tab has no rule above it
 * @param action  a control that belongs to the whole chapter, shown beside the heading
 */
export function Chapter({ id, title, note, action, first = false, children }: { id: string; title: string; note?: string; action?: React.ReactNode; first?: boolean; children: React.ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className={cn("scroll-mt-6 space-y-6", !first && "border-t pt-8")}>
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
