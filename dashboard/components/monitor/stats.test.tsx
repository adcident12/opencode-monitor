import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { useState } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { I18nProvider } from "@/lib/i18n"
import type { McpStat, PeriodSummary, Stats as StatsData } from "@/lib/types"
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
  compare: null,
  context: null,
  speed: { models: [{ model: "local-llama/qwen3.8-27b-v3", requests: 118, writeTps: 31.6, readTps: 540, firstTokenMs: 1200, daily: [] }] },
  usage: { requests: 120, input: 45_500, cacheRead: 1_222_000, cacheWrite: 0, output: 9_400, reasoning: 0, cost: 0, cachedPct: 96, start: { median: 32_400, min: 30_100, max: 41_000, sessions: 5 } },
  stuckMs: 600_000,
  daily: [],
  totals: { sessions: 1, activeMs: 0, waitMs: 0, prompts: 0, open: 0, abandoned: 0, medianAnswerMs: null, stuck: 0, abandonedCalls: 0, toolCalls: 43, toolErrors: 8, compactions: 0 },
  waits: [], slow: [], tools: [], explore: { graft: 0, other: 0 }, rereads: [], skills: [],
  ...extra,
})

const summary = (extra: Partial<PeriodSummary> = {}): PeriodSummary => ({
  days: 10, sessions: 12, startTokens: 43_500, compactionsPerSession: 2.4, rereadsPerSession: 1.5, toolCallsPerSession: 90, toolErrorPct: 4,
  mcpNoAnswerPct: 0.5, cachedPct: 93, writeTps: 14.4, firstTokenMs: 2100, medianAnswerMs: 23_000, ...extra,
})

let requested: string[] = []

beforeEach(() => {
  requested = []
  vi.stubGlobal("fetch", async (url: string) => {
    requested.push(url)
    if (url.startsWith("/api/stats")) {
      if (url.includes("split=")) {
        const split = /split=([\d-]+)/.exec(url)![1]
        const after = summary({ days: 4, sessions: 2, startTokens: 32_400, writeTps: 27.2, toolErrorPct: 6 })
        return Response.json(figures({ compare: { split, model: "local-llama/qwen3.8-27b-v3", before: summary(), after } }))
      }
      const one = url.includes("session=ses_shop")
      const context = { limit: 131_072, peak: 120_000, requests: 4, rereadAfterCompaction: 3, points: [30_000, 120_000, 35_000, 60_000].map((tokens, i) => ({ t: NOW + i, tokens })), compactions: [{ t: NOW + 2, at: 2, before: 120_000, after: 35_000, reread: 3 }] }
      return Response.json(figures(one ? { context, session: { id: "ses_shop", title: "Checkout flow", project: "shop" }, mcp: [server("memory", { unused: true, disconnects: null, startFailures: null })] } : {}))
    }
    const code = /\/i18n\/(\w+)\.json$/.exec(url)?.[1] ?? "en"
    return new Response(readFileSync(join(__dirname, "..", "..", "..", "i18n", `${code}.json`), "utf8"))
  })
  window.history.replaceState(null, "", "/?lang=en")
})

// The page keeps the chosen session in the URL; here plain state stands in for it.
function Harness() {
  const [session, setSession] = useState<string | null>(null)
  return <Stats session={session} onSession={setSession} />
}

const renderStats = () =>
  render(
    <I18nProvider>
      <Harness />
    </I18nProvider>
  )

describe("Tokens in Stats", () => {
  it("shows what was sent, how much of it was cached, and how big a session starts", async () => {
    renderStats()
    expect(await screen.findByText("1.3M")).toBeInTheDocument()
    expect(screen.getByText("96% reused from its cache")).toBeInTheDocument()
    expect(screen.getByText("32.4k")).toBeInTheDocument()
    expect(screen.getByText("30.1k to 41.0k over 5 sessions")).toBeInTheDocument()
    // No cost was recorded (a local model), so no cost is shown.
    expect(screen.queryByText("Cost")).not.toBeInTheDocument()
  })
})

describe("Before and after in Stats", () => {
  it("puts the two sides of a chosen day next to each other and says which way is better", async () => {
    renderStats()
    await userEvent.click(await screen.findByRole("combobox", { name: "Compare before and after a day" }))
    await userEvent.click((await screen.findAllByRole("option"))[2])

    const table = within(await screen.findByRole("region", { name: "Before and after" }))
    const row = (name: string) => within(table.getByRole("rowheader", { name: new RegExp(name) }).closest("tr")!)
    // Fewer tokens at the start is an improvement; a higher failure rate is not.
    expect(row("Tokens a session starts at").getByText("43.5k")).toBeInTheDocument()
    expect(row("Tokens a session starts at").getByText("32.4k")).toBeInTheDocument()
    expect(row("Tokens a session starts at").getByText("better")).toBeInTheDocument()
    expect(row("Writing speed").getByText("better")).toBeInTheDocument()
    expect(row("Tool calls that failed").getByText("worse")).toBeInTheDocument()
    expect(row("Compactions per session").getByText("no change")).toBeInTheDocument()
    expect(table.getByText("Before (10 d, 12 sessions)")).toBeInTheDocument()
    // Two sessions on one side is not enough to conclude anything, and the page says so.
    expect(table.getByText(/fewer than 3 sessions/)).toBeInTheDocument()
  })
})

describe("Model speed in Stats", () => {
  it("shows writing and reading apart for each model", async () => {
    renderStats()
    const row = (await screen.findByText("local-llama/qwen3.8-27b-v3")).closest("tr")!
    expect(within(row).getByText("31.6 tok/s")).toBeInTheDocument()
    expect(within(row).getByText("540 tok/s")).toBeInTheDocument()
    expect(within(row).getByText("1.2s")).toBeInTheDocument()
    expect(within(row).getByText("118 requests")).toBeInTheDocument()
  })
})

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
    // Off and idle: named in one line, not given a row of zeros.
    expect(screen.getByText("Switched off, with nothing to report:").parentElement).toHaveTextContent("github")
    expect(screen.queryByText("off")).not.toBeInTheDocument()
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
    // Its context: how full it got, and what the compaction cost.
    expect(screen.getByText("peak 120k of 131k (92%)")).toBeInTheDocument()
    expect(screen.getByText("compacted from 120k to 35.0k")).toBeInTheDocument()
    expect(screen.getByText("3 files read again afterwards")).toBeInTheDocument()
  })
})
