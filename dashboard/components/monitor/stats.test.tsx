import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { useState } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { I18nProvider } from "@/lib/i18n"
import type { ConfigChange, CostReport, McpStat, PeriodSummary, Stats as StatsData } from "@/lib/types"
import { Stats } from "./stats"

const NOW = 1_800_000_000_000

const server = (name: string, extra: Partial<McpStat> = {}): McpStat => ({
  name, type: "local", enabled: true, scope: "global", calls: 0, errors: 0, faults: 0, avgMs: null, lastUsedAt: null, sessions: 0,
  disconnects: 0, startFailures: 0, unused: false, tools: [], moreTools: 0, ...extra,
})

const figures = (extra: Partial<StatsData> = {}): StatsData => ({
  range: { from: NOW - 14 * 86_400_000, to: NOW, days: 14 },
  session: null,
  sessions: [{ id: "ses_shop", title: "Checkout flow", project: "shop", toolCalls: 12, lastAt: NOW, activeMs: 3_600_000, waitMs: 0, compactions: 0, tokens: 0, cost: 0 }],
  mcp: [
    server("chrome-devtools", { calls: 40, errors: 6, faults: 2, avgMs: 1400, lastUsedAt: NOW, sessions: 3, disconnects: 1, tools: [{ tool: "evaluate_script", count: 30, errors: 6, faults: 0 }] }),
    server("memory", { unused: true }),
    server("godot", { scope: "project", calls: 3, avgMs: 320 }),
    server("github", { enabled: false, type: "remote" }),
  ],
  mcpLogFrom: NOW - 2 * 86_400_000,
  compare: null,
  takeaways: [],
  work: {
    time: { readingMs: 600_000, thinkingMs: 6_000_000, writingMs: 1_200_000, toolMs: 300_000 },
    turns: {
      count: 20, ended: { done: 12, continued: 4, cut: 2, aborted: 1, error: 0, unanswered: 1, open: 0 }, medianSteps: 8, medianMs: 1_020_000, longestMs: 7_200_000,
      cut: [{ at: NOW, model: "local/qwen", project: "shop", title: "Checkout flow" }],
    },
    permissions: { asked: 9, top: [{ permission: "external_directory", pattern: "C:\\temp\\*", count: 7, waitMs: 60_000, lastAt: NOW }] },
    files: { edits: 0, files: 0, top: [] },
    agents: [{ agent: "build", requests: 100, activeMs: 3_600_000, tokens: 1_000_000, cost: 0, subagent: false }],
    plans: { sessions: 0, total: 0, completed: 0, inProgress: 0, pending: 0, cancelled: 0, dropped: 0, rewrites: 0, unfinished: [] },
  },
  context: null,
  speed: { models: [{ model: "local-llama/qwen3.8-27b-v3", requests: 118, writeTps: 31.6, readTps: 540, firstTokenMs: 1200, daily: [] }] },
  usage: { requests: 120, input: 45_500, cacheRead: 1_222_000, cacheWrite: 0, output: 9_400, reasoning: 0, cost: 0, cachedPct: 96, start: { median: 32_400, min: 30_100, max: 41_000, sessions: 5 } },
  stuckMs: 600_000,
  daily: [],
  totals: { sessions: 1, activeMs: 0, waitMs: 0, prompts: 0, open: 0, abandoned: 0, medianAnswerMs: null, stuck: 0, abandonedCalls: 0, toolCalls: 43, toolErrors: 8, compactions: 0, serverLimitCompactions: 0 },
  waits: [], slow: [], tools: [], explore: { graft: 0, other: 40 }, skills: [],
  rereads: Array.from({ length: 12 }, (_, i) => ({ file: `/src/file${i}.ts`, count: 20 - i, project: "shop", title: "Checkout flow" })),
  ...extra,
})

const summary = (extra: Partial<PeriodSummary> = {}): PeriodSummary => ({
  days: 10, sessions: 12, startTokens: 43_500, compactionsPerSession: 2.4, rereadsPerSession: 1.5, toolCallsPerSession: 90, toolErrorPct: 4,
  mcpNoAnswerPct: 0.5, cachedPct: 93, costPerSession: null, writeTps: 14.4, firstTokenMs: 2100, medianAnswerMs: 23_000, ...extra,
})

let requested: string[] = []
let configChanges: ConfigChange[] = []

beforeEach(() => {
  requested = []
  configChanges = []
  vi.stubGlobal("fetch", async (url: string) => {
    requested.push(url)
    if (url.startsWith("/api/stats")) {
      if (url.includes("split=")) {
        const split = /split=([\d-]+)/.exec(url)![1]
        const after = summary({ days: 4, sessions: 2, startTokens: 32_400, writeTps: 27.2, toolErrorPct: 6 })
        return Response.json(figures({ compare: { split, model: "local-llama/qwen3.8-27b-v3", before: summary(), after } }))
      }
      const one = url.includes("session=ses_shop")
      const context = { limit: 131_072, compactAt: 99_072, peak: 120_000, requests: 4, rereadAfterCompaction: 3, points: [30_000, 120_000, 35_000, 60_000].map((tokens, i) => ({ t: NOW + i, tokens })), compactions: [{ t: NOW + 2, at: 2, before: 120_000, after: 35_000, reread: 3 }] }
      return Response.json(figures(one ? { context, session: { id: "ses_shop", title: "Checkout flow", project: "shop" }, mcp: [server("memory", { unused: true, disconnects: null, startFailures: null })] } : {}))
    }
    if (url.startsWith("/api/config-changes")) return Response.json(configChanges)
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

describe("Prompt cache lost in Stats", () => {
  const english = () => readFileSync(join(__dirname, "..", "..", "..", "i18n", "en.json"), "utf8")
  const withDrops = (cacheDrops: StatsData["cacheDrops"]) =>
    vi.stubGlobal("fetch", async (url: string) => (url.startsWith("/api/stats") ? Response.json(figures({ cacheDrops })) : new Response(english())))

  it("lists the causes, what is worth looking into first, and the time each took", async () => {
    withDrops({
      checked: 500, count: 12, tokens: 2_000_000, unexpected: { count: 3, tokens: 400_000, ms: 0 },
      byCause: { compaction: { count: 9, tokens: 1_600_000, ms: 3_000_000 }, new_turn: { count: 3, tokens: 400_000, ms: 0 } },
    })
    renderStats()
    expect(await screen.findByText("12 times the model read again 2.0M tokens its server had cached, out of 500 requests that could have reused it")).toBeInTheDocument()
    const rows = within(screen.getByRole("columnheader", { name: "When it happened" }).closest("table")!).getAllByRole("row").slice(1)
    expect(rows.map(r => within(r).getByRole("rowheader").firstChild?.textContent)).toEqual(["At a new turn", "After a compaction"])
    expect(rows[0]).toHaveTextContent("–")
    expect(rows[1]).toHaveTextContent("50m")
  })

  it("is left out when nothing was lost", async () => {
    withDrops({ checked: 500, count: 0, tokens: 0, unexpected: { count: 0, tokens: 0, ms: 0 }, byCause: {} })
    renderStats()
    await screen.findByRole("heading", { name: "Where the time went" })
    expect(screen.queryByText("When it happened")).not.toBeInTheDocument()
  })
})

describe("Going round in circles in Stats", () => {
  it("lists each loop with how many times or how long, and marks one still going", async () => {
    const english = readFileSync(join(__dirname, "..", "..", "..", "i18n", "en.json"), "utf8")
    const ep = { session_id: "ses_shop", project: "shop", title: "Checkout flow", tools: null, tool: null, text: null, workMs: null, calls: null, open: null, times: null, to: NOW }
    vi.stubGlobal("fetch", async (url: string) =>
      url.startsWith("/api/stats")
        ? Response.json(figures({ loops: { count: 2, byKind: { failing: 1, plan_stalled: 1 }, episodes: [
            { ...ep, kind: "failing", at: NOW, tool: "evaluate_script", times: 257, ongoing: true },
            { ...ep, kind: "plan_stalled", at: NOW - 1000, workMs: 4_500_000, calls: 186, open: 2, ongoing: false },
          ] } }))
        : new Response(english)
    )
    renderStats()
    const list = (await screen.findByRole("heading", { name: "Going round in circles" })).closest("section")!
    const items = within(list).getAllByRole("listitem")
    expect(items[0]).toHaveTextContent("×257")
    expect(items[0]).toHaveTextContent("evaluate_script failing again and again")
    expect(items[0]).toHaveTextContent("still going")
    expect(items[1]).toHaveTextContent("the plan not moving: 186 calls, 2 items open")
    expect(items[1]).not.toHaveTextContent("still going")
  })

  it("says so when there was none", async () => {
    vi.stubGlobal("fetch", async (url: string) =>
      url.startsWith("/api/stats") ? Response.json(figures({ loops: { count: 0, byKind: {}, episodes: [] } })) : new Response(readFileSync(join(__dirname, "..", "..", "..", "i18n", "en.json"), "utf8"))
    )
    renderStats()
    expect(await screen.findByText("The agent did not go round in circles.")).toBeInTheDocument()
  })
})

describe("What it cost in Stats", () => {
  const english = () => readFileSync(join(__dirname, "..", "..", "..", "i18n", "en.json"), "utf8")
  const day = (date: string, cost: number) => ({ date, cost, requests: cost ? 2 : 0, tokens: 0 })
  const report = (extra: Partial<CostReport> = {}): CostReport => ({
    currency: "USD",
    today: { cost: 8.5, requests: 4, tokens: 90_000 },
    month: { cost: 48.5, requests: 40, tokens: 900_000, month: "2027-01", projected: 92.4 },
    daily: [day("2027-01-14", 0), day("2027-01-15", 8.5)],
    monthly: [{ month: "2026-12", cost: 12, requests: 9, tokens: 0, models: [] }, { month: "2027-01", cost: 48.5, requests: 40, tokens: 0, models: [] }],
    models: [{ model: "cloud/large", cost: 40.25, requests: 30, tokens: 700_000, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }],
    sessions: [{ session_id: "s1", cost: 21.5, requests: 12, project: "shop", title: "Checkout flow" }],
    budget: { warnPct: 80, daily: { limit: 10, spent: 8.5, pct: 85, level: "warn" }, monthly: { limit: 50, spent: 48.5, pct: 97, level: "warn" }, projected: 92.4 },
    any: true,
    ...extra,
  })
  const serve = (costs: CostReport) =>
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.startsWith("/api/stats")) return Response.json(figures())
      if (url.startsWith("/api/costs")) return Response.json(costs)
      return new Response(english())
    })

  it("shows today and the month against the budget, where the month heads, by model and by session", async () => {
    serve(report())
    renderStats()
    const section = (await screen.findByRole("heading", { name: "What it cost" })).closest("section")!
    expect(within(section).getByText("$8.50")).toBeInTheDocument()
    expect(within(section).getByText("of $10.00 budget · 85%")).toBeInTheDocument()
    expect(within(section).getByText("$92.40")).toBeInTheDocument()
    expect(within(section).getByText("past the budget of $50.00")).toBeInTheDocument()
    expect(within(section).getByRole("rowheader", { name: "cloud/large" })).toBeInTheDocument()
    expect(within(section).getByText("$40.25")).toBeInTheDocument()
    expect(within(section).getByText("Checkout flow")).toBeInTheDocument()
  })

  it("is left out for someone who pays for nothing and set no budget", async () => {
    serve(report({ any: false, budget: { warnPct: 80, daily: null, monthly: null, projected: null } }))
    renderStats()
    await screen.findByRole("heading", { name: "Where the time went" })
    await new Promise(r => setTimeout(r, 50))
    expect(screen.queryByRole("heading", { name: "What it cost" })).not.toBeInTheDocument()
  })
})

describe("Takeaways in Stats", () => {
  it("is left out when no rule held", async () => {
    renderStats()
    await screen.findByRole("heading", { name: "Where the time went" })
    expect(screen.queryByRole("heading", { name: "Worth knowing" })).not.toBeInTheDocument()
  })

  it("says each in a sentence with its figures, marks what to change, and links to the details", async () => {
    const english = readFileSync(join(__dirname, "..", "..", "..", "i18n", "en.json"), "utf8")
    vi.stubGlobal("fetch", async (url: string) =>
      url.startsWith("/api/stats")
        ? Response.json(figures({
            takeaways: [
              { id: "permission_repeat", tone: "act", vars: { n: 7, permission: "external_directory", pattern: "C:\\temp\\*" }, anchor: "stats-you" },
              { id: "waited", tone: "note", vars: { hours: 1.5, prompts: 9 }, anchor: "stats-you" },
            ],
          }))
        : new Response(english)
    )
    const scrolled = vi.fn()
    Element.prototype.scrollIntoView = scrolled
    window.matchMedia ??= (() => ({ matches: false })) as unknown as typeof window.matchMedia
    renderStats()
    const box = (await screen.findByRole("heading", { name: "Worth knowing" })).closest("section")!
    const items = within(box).getAllByRole("listitem")
    expect(items).toHaveLength(2)
    expect(items[0]).toHaveTextContent("To change")
    expect(items[0]).toHaveTextContent("You were asked 7 times to allow external_directory: C:\\temp\\*.")
    expect(items[1]).not.toHaveTextContent("To change")
    expect(items[1]).toHaveTextContent("waited 1.5 h for your answer to 9 questions")
    await userEvent.click(within(items[0]).getByRole("button", { name: "Details" }))
    expect(scrolled).toHaveBeenCalled()
  })
})

describe("Beyond tool calls in Stats", () => {
  it("splits the agent's time four ways, each part written out, and names the biggest", async () => {
    renderStats()
    const split = (await screen.findByRole("heading", { name: "Where the time went" })).closest("section")!
    expect(within(split).getByText("Thinking")).toBeInTheDocument()
    expect(within(split).getByText("1h 40m")).toBeInTheDocument()
    expect(within(split).getByText("· 74%")).toBeInTheDocument()
    expect(within(split).getByText(/Most of the time \(74%\) is the model thinking/)).toBeInTheDocument()
  })

  it("says how prompts ended, and what to do about replies cut off at the output limit", async () => {
    renderStats()
    const turns = (await screen.findByRole("heading", { name: "Your prompts" })).closest("section")!
    expect(within(turns).getByText("Continued by your next prompt")).toBeInTheDocument()
    expect(within(turns).getByText(/2 replies were cut off/)).toBeInTheDocument()
    // Endings that did not happen are not listed.
    expect(within(turns).queryByText("Failed with an error")).not.toBeInTheDocument()
  })

  it("lists what interrupted you, and shows nothing for parts with no data", async () => {
    renderStats()
    expect(await screen.findByText("external_directory")).toBeInTheDocument()
    expect(screen.getByText("C:\\temp\\*")).toBeInTheDocument()
    // One agent, no edits and no plans: those sections, and the "What got done" chapter, are left out.
    expect(screen.queryByRole("heading", { name: "Agents" })).not.toBeInTheDocument()
    expect(screen.queryByRole("heading", { name: "What got done" })).not.toBeInTheDocument()
  })
})

describe("What is shown depends on what this machine has", () => {
  it("says nothing about graft to someone who does not have it", async () => {
    renderStats()
    await screen.findByText("chrome-devtools")
    expect(screen.queryByText(/graft was used for/)).not.toBeInTheDocument()
  })
})

describe("Re-read files in Stats", () => {
  it("shows the first ten, and the rest when asked", async () => {
    renderStats()
    expect(await screen.findByText("/src/file9.ts")).toBeInTheDocument()
    expect(screen.queryByText("/src/file10.ts")).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Show all (2 more)" }))
    expect(screen.getByText("/src/file11.ts")).toBeInTheDocument()
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

  it("lists the days OpenCode's settings changed, and compares from one at a click", async () => {
    const at = Date.now() - 2 * 86_400_000
    configChanges = [
      {
        t: at, file: "~/.config/opencode/opencode.json", global: true, more: 0,
        changes: [
          { path: "provider.local.models.qwen.limit.output", kind: "changed", from: 8192, to: 16384 },
          { path: "mcp.trivy.enabled", kind: "added", from: null, to: false },
          { path: "provider.local.options.baseURL", kind: "changed", hidden: true },
        ],
      },
      // Older than any day the period can be split at.
      { t: Date.now() - 13 * 86_400_000, file: "~/work/shop/opencode.json", global: false, more: 0, changes: [{ path: "model", kind: "removed", from: "a/x", to: null }] },
    ]
    renderStats()
    const box = within((await screen.findByRole("heading", { name: "OpenCode settings changed in this period" })).closest("section")!)
    expect(box.getByText("8192 → 16384")).toBeInTheDocument()
    expect(box.getByText("false (added)")).toBeInTheDocument()
    // An address is not kept, only that it changed.
    expect(box.getByText("changed")).toBeInTheDocument()
    expect(box.getByText("removed")).toBeInTheDocument()
    expect(box.getByText("project")).toBeInTheDocument()
    expect(box.getByText("No earlier day in this period to compare with")).toBeInTheDocument()

    await userEvent.click(box.getByRole("button", { name: "Compare before and after" }))
    expect(await screen.findByRole("region", { name: "Before and after" })).toBeInTheDocument()
    const d = new Date(at)
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
    expect(requested.some(url => url.includes(`split=${day}`))).toBe(true)
    expect(box.getByText("Compared below")).toBeInTheDocument()
    // And the picker marks that day.
    expect(screen.getByRole("combobox", { name: "Compare before and after a day" })).toHaveTextContent("settings changed")
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
