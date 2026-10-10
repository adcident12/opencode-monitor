import { render, screen, within } from "@testing-library/react"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { I18nProvider } from "@/lib/i18n"
import type { SetupReport } from "@/lib/types"
import { Setup } from "./setup"

const report = (extra: Partial<SetupReport> = {}): SetupReport => ({
  monitor: { version: "8.0.0", port: 4317, lang: "en", configFile: { path: "/srv/monitor/config.json", found: false }, platform: "linux" },
  opencode: {
    dataDir: "/home/ana/.local/share/opencode",
    database: { path: "/home/ana/.local/share/opencode/opencode.db", found: true, bytes: 1000 },
    log: { path: "/home/ana/.local/share/opencode/log/opencode.log", found: false, bytes: null },
    configDir: "/home/ana/.config/opencode", configFiles: ["opencode.json"], version: "1.18.35", tested: "1.18.35", running: true,
  },
  compaction: { auto: true, reserved: null, outputTokenMax: null },
  models: [
    { id: "ollama/small-coder", requests: 40, lastAt: 1, context: 32_768, output: 4096, input: null, source: "opencode", compactAt: 28_672 },
    { id: "ollama/mystery", requests: 3, lastAt: 0, context: null, output: null, input: null, source: null, compactAt: null },
  ],
  mcp: [{ name: "context7", type: "remote", enabled: true }],
  notify: {
    desktop: true, discord: true, on: ["waiting", "compact_soon"], repeatMinutes: 30, weekly: { enabled: true, weekday: 1, hour: 9 },
    recent: [
      { t: 1_800_000_000_000, kind: "stuck", title: "Probably stuck", subject: "shop — Checkout", desktop: "sent", discord: "failed (HTTP 404)" },
    ],
  },
  history: { enabled: true, file: "data/history.jsonl", retentionDays: 30, count: 12 },
  problems: [{ code: "no_log", subject: "/home/ana/.local/share/opencode/log/opencode.log" }, { code: "model_limit_unknown", subject: "ollama/mystery" }],
  ...extra,
})

let body: SetupReport

beforeEach(() => {
  body = report()
  vi.stubGlobal("fetch", async (url: string) => {
    if (url.startsWith("/api/setup")) return Response.json(body)
    const code = /\/i18n\/(\w+)\.json$/.exec(url)?.[1] ?? "en"
    return new Response(readFileSync(join(__dirname, "..", "..", "..", "i18n", `${code}.json`), "utf8"))
  })
  window.history.replaceState(null, "", "/?lang=en")
})

const renderSetup = () =>
  render(
    <I18nProvider>
      <Setup active />
    </I18nProvider>,
  )

describe("This machine", () => {
  it("shows each model's own compaction point, for a machine unlike the author's", async () => {
    renderSetup()
    const row = (await screen.findByText("ollama/small-coder")).closest("tr")!
    expect(within(row).getByText("32.8k")).toBeInTheDocument()
    expect(within(row).getByText("28.7k")).toBeInTheDocument()
    expect(within(screen.getByText("ollama/mystery").closest("tr")!).getByText("limit unknown")).toBeInTheDocument()
  })

  it("names what is missing and what to do about it", async () => {
    renderSetup()
    expect(await screen.findByText("No context limit is known for ollama/mystery")).toBeInTheDocument()
    expect(screen.getByText(/Give the model a "limit"/)).toBeInTheDocument()
    expect(screen.getByText(/OpenCode's log was not found at/)).toBeInTheDocument()
    expect(screen.getByText("waiting for you, about to be compacted")).toBeInTheDocument()
  })

  it("shows what was sent and which channel refused it", async () => {
    renderSetup()
    const row = (await screen.findByText("Probably stuck")).closest("tr")!
    expect(within(row).getByText("shop — Checkout")).toBeInTheDocument()
    expect(within(row).getByText("sent")).toBeInTheDocument()
    expect(within(row).getByText("failed (HTTP 404)")).toBeInTheDocument()
  })

  it("says so when nothing is missing", async () => {
    body = report({ problems: [] })
    renderSetup()
    expect(await screen.findByText("Everything the monitor needs was found on this machine.")).toBeInTheDocument()
  })
})
