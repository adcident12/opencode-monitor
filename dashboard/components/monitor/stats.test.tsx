import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { I18nProvider } from "@/lib/i18n"
import type { McpStat, Stats as StatsData } from "@/lib/types"
import { Stats } from "./stats"

const NOW = 1_800_000_000_000

const server = (name: string, extra: Partial<McpStat> = {}): McpStat => ({
  name, type: "local", enabled: true, scope: "global", calls: 0, errors: 0, faults: 0, avgMs: null, lastUsedAt: null, sessions: 0,
  disconnects: 0, startFailures: 0, unused: false, tools: [], moreTools: 0, ...extra,
})

const figures = (extra: Partial<StatsData> = {}): StatsData => ({
  range: { from: NOW - 14 * 86_400_000, to: NOW, days: 14 },
  session: null,
  sessions: [{ id: "ses_shop", title: "Checkout flow", project: "shop", toolCalls: 12, lastAt: NOW }],
  mcp: [
    server("chrome-devtools", { calls: 40, errors: 6, faults: 2, avgMs: 1400, lastUsedAt: NOW, sessions: 3, disconnects: 1, tools: [{ tool: "evaluate_script", count: 30, errors: 6, faults: 0 }] }),
    server("memory", { unused: true }),
    server("godot", { scope: "project", calls: 3, avgMs: 320 }),
    server("github", { enabled: false, type: "remote" }),
  ],
  mcpLogFrom: NOW - 2 * 86_400_000,
  stuckMs: 600_000,
  daily: [],
  totals: { sessions: 1, activeMs: 0, waitMs: 0, prompts: 0, open: 0, abandoned: 0, medianAnswerMs: null, stuck: 0, abandonedCalls: 0, toolCalls: 43, toolErrors: 8, compactions: 0 },
  waits: [], slow: [], tools: [], explore: { graft: 0, other: 0 }, rereads: [], skills: [],
  ...extra,
})

let requested: string[] = []

beforeEach(() => {
  requested = []
  vi.stubGlobal("fetch", async (url: string) => {
    requested.push(url)
    if (url.startsWith("/api/stats")) {
      const one = url.includes("session=ses_shop")
      return Response.json(figures(one ? { session: { id: "ses_shop", title: "Checkout flow", project: "shop" }, mcp: [server("memory", { unused: true, disconnects: null, startFailures: null })] } : {}))
    }
    const code = /\/i18n\/(\w+)\.json$/.exec(url)?.[1] ?? "en"
    return new Response(readFileSync(join(__dirname, "..", "..", "..", "i18n", `${code}.json`), "utf8"))
  })
  window.history.replaceState(null, "", "/?lang=en")
})

const renderStats = () =>
  render(
    <I18nProvider>
      <Stats />
    </I18nProvider>
  )

describe("MCP servers in Stats", () => {
  it("keeps a tool's own errors apart from the server not answering", async () => {
    renderStats()
    const row = (await screen.findByText("chrome-devtools")).closest("li")!
    expect(within(row).getByText("40 calls")).toBeInTheDocument()
    expect(within(row).getByText("6 failed")).toBeInTheDocument()
    expect(within(row).getByText("2 no answer")).toBeInTheDocument()
    expect(within(row).getByText("dropped 1×")).toBeInTheDocument()
    expect(within(row).getByText("1.4s per call")).toBeInTheDocument()

    await userEvent.click(within(row).getByRole("button", { name: "Tools of chrome-devtools" }))
    expect(await within(row).findByText("evaluate_script")).toBeInTheDocument()
  })

  it("names what is switched on but never called, and what is off or from a project", async () => {
    renderStats()
    const memory = (await screen.findByText("memory")).closest("li")!
    expect(within(memory).getByText("never used")).toBeInTheDocument()
    expect(screen.getByText(/Switched on but never called in this period: memory\./)).toBeInTheDocument()
    expect(within(screen.getByText("godot").closest("li")!).getByText("project")).toBeInTheDocument()
    expect(within(screen.getByText("github").closest("li")!).getByText("off")).toBeInTheDocument()
    // The log starts inside the period, so earlier failures are unknown rather than zero.
    expect(screen.getByText(/log only goes back to/)).toBeInTheDocument()
  })

  it("asks the server for one session, and says what cannot be known for it", async () => {
    renderStats()
    await userEvent.click(await screen.findByRole("combobox", { name: "Session" }))
    await userEvent.click(await screen.findByRole("option", { name: "shop · Checkout flow" }))

    expect(await screen.findByText(/Dropped connections and failed starts are not shown for a single session/)).toBeInTheDocument()
    expect(requested.some(url => url.includes("session=ses_shop"))).toBe(true)
    expect(screen.queryByText("chrome-devtools")).not.toBeInTheDocument()
    expect(screen.getByText("Switched on but never called in this session: memory.")).toBeInTheDocument()
  })
})
