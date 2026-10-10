import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { I18nProvider } from "@/lib/i18n"
import type { HistoryEvent } from "@/lib/types"
import { History } from "./history"

const NOW = 1_800_000_000_000

// 130 changes, newest first, as the server keeps them.
const all: HistoryEvent[] = Array.from({ length: 130 }, (_, i) => ({
  t: NOW - i * 60_000, since: NOW - i * 60_000, id: `ses_${i % 3}`, title: `Session ${i}`, project: "shop",
  from: "working", fromMs: 60_000, to: i % 2 ? "waiting" : "working", reason: "tool", permission: null, limitMs: null, error: null, detail: null,
}))

let requested: string[] = []

beforeEach(() => {
  requested = []
  vi.stubGlobal("fetch", async (url: string) => {
    requested.push(url)
    if (url.startsWith("/api/history/sessions")) return Response.json([])
    if (url.startsWith("/api/stats")) {
      const row = (id: string, title: string, activeMs: number, compactions: number) => ({ id, title, project: "shop", toolCalls: 10, lastAt: NOW, activeMs, waitMs: 60_000, compactions, tokens: 120_000, cost: id === "ses_big" ? 4.2 : 0 })
      return Response.json({ sessions: [row("ses_small", "Small fix", 600_000, 0), row("ses_big", "Big refactor", 7_200_000, 4)] })
    }
    if (url.startsWith("/api/history")) {
      const q = new URL(url, "http://x").searchParams
      const before = q.get("before")
      const after = q.get("after")
      const limit = Number(q.get("limit"))
      let list = all.filter(e => !q.get("attention") || e.to === "waiting")
      if (before) list = list.filter(e => e.t < Number(before.split(":")[0]))
      if (after) list = list.filter(e => e.t > Number(after.split(":")[0]))
      return Response.json({ events: list.slice(0, limit), more: Math.max(0, list.length - limit), truncated: false })
    }
    const code = /\/i18n\/(\w+)\.json$/.exec(url)?.[1] ?? "en"
    return new Response(readFileSync(join(__dirname, "..", "..", "..", "i18n", `${code}.json`), "utf8"))
  })
  window.history.replaceState(null, "", "/?lang=en")
})

const renderHistory = () =>
  render(
    <I18nProvider>
      <History count={all.length} active session={null} onSession={() => {}} />
    </I18nProvider>,
  )

describe("What each session took", () => {
  it("lists the costliest session first, and picks it for the list when clicked", async () => {
    const picked: (string | null)[] = []
    render(
      <I18nProvider>
        <History count={all.length} active session={null} onSession={id => picked.push(id)} />
      </I18nProvider>,
    )
    const rows = await screen.findAllByRole("button", { name: /Big refactor|Small fix/ })
    expect(rows.map(r => r.textContent)).toEqual(["Big refactor", "Small fix"])
    // Someone paid for a model here, so what each session cost is shown.
    expect(screen.getByRole("columnheader", { name: "Cost" })).toBeInTheDocument()
    expect(screen.getByText("$4.20")).toBeInTheDocument()
    await userEvent.click(rows[0])
    expect(picked).toEqual(["ses_big"])
  })
})

describe("History pages", () => {
  it("shows a page, then the page below it when asked, without repeating any entry", async () => {
    renderHistory()
    expect(await screen.findByText("Session 0")).toBeInTheDocument()
    expect(screen.queryByText("Session 100")).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole("button", { name: "Load older entries (30 more)" }))
    expect(await screen.findByText("Session 129")).toBeInTheDocument()
    expect(screen.getAllByText("Session 99")).toHaveLength(1)
    expect(screen.queryByRole("button", { name: /Load older/ })).not.toBeInTheDocument()
  })

  it("puts what arrives later at the top, keeping the older pages already loaded", async () => {
    const view = renderHistory()
    await screen.findByText("Session 0")
    await userEvent.click(screen.getByRole("button", { name: "Load older entries (30 more)" }))
    await screen.findByText("Session 129")

    all.unshift({ ...all[0], t: NOW + 60_000, title: "Just now" })
    view.rerender(
      <I18nProvider>
        <History count={all.length} active session={null} onSession={() => {}} />
      </I18nProvider>,
    )
    expect(await screen.findByText("Just now")).toBeInTheDocument()
    expect(screen.getByText("Session 129")).toBeInTheDocument()
    expect(requested.some(url => url.includes("after="))).toBe(true)
    all.shift()
  })

  it("asks the server to filter, so the filter covers the whole record and not one page", async () => {
    renderHistory()
    await screen.findByText("Session 0")
    await userEvent.click(screen.getByRole("switch"))
    expect(await screen.findByText("Session 1")).toBeInTheDocument()
    expect(screen.queryByText("Session 0")).not.toBeInTheDocument()
    expect(requested.some(url => url.includes("attention=1"))).toBe(true)
  })
})
