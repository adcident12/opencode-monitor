import { describe, expect, it } from "vitest"
import { markDataUrl, markSvg, TAB_COLOURS } from "./logo"

describe("the mark", () => {
  it("carries the state of the sessions in its dot, and nothing else changes", () => {
    const waiting = markSvg(TAB_COLOURS.waiting)
    const working = markSvg(TAB_COLOURS.working)
    expect(waiting).toContain(`fill="${TAB_COLOURS.waiting}"`)
    expect(waiting.replace(TAB_COLOURS.waiting, "")).toBe(working.replace(TAB_COLOURS.working, ""))
  })

  it("is a self-contained image the tab can show without a request", () => {
    const url = markDataUrl("stuck")
    expect(url.startsWith("data:image/svg+xml,")).toBe(true)
    expect(decodeURIComponent(url)).toContain(TAB_COLOURS.stuck)
    // No script, no outside reference: only shapes.
    // And none of OpenCode's: its logo is a rectangular frame, this is a ring and a dot.
    expect(decodeURIComponent(url)).not.toMatch(/<path|fill-rule/)
    expect(decodeURIComponent(url)).not.toMatch(/<script|href=|url\(/)
  })
})
