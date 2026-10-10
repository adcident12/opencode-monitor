import { render, screen, within } from "@testing-library/react"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { TooltipProvider } from "@/components/ui/tooltip"
import { I18nProvider } from "@/lib/i18n"
import type { Snapshot } from "@/lib/types"
import { Environment } from "./environment"
import { Header } from "./header"
import { toneOf } from "./state"

// Serve the real string files to the I18nProvider.
beforeEach(() => {
  vi.stubGlobal("fetch", async (url: string) => {
    const code = /\/i18n\/(\w+)\.json$/.exec(url)?.[1] ?? "en"
    return new Response(readFileSync(join(__dirname, "..", "..", "..", "i18n", `${code}.json`), "utf8"))
  })
  window.history.replaceState(null, "", "/?lang=en")
})

const snapshot = (extra: Partial<Snapshot> = {}): Snapshot => ({
  now: 1_800_000_000_000, opencodeRunning: true, stale: false, lookbackHours: 24, sessions: [], environment: null, historyCount: 0,
  build: "b1", version: "10.2.0", opencodeVersion: "1.18.35", opencodeTested: "1.18.35", opencodeUntested: false, ...extra,
})

const renderHeader = (snap: Snapshot | null, connected = true) =>
  render(
    <I18nProvider>
      <TooltipProvider>
        <Header snapshot={snap} connected={connected} tone="quiet" />
      </TooltipProvider>
    </I18nProvider>
  )

describe("The status line of the header", () => {
  it("says the page is live and OpenCode is running, in an element that is announced", async () => {
    renderHeader(snapshot())
    const status = await screen.findByRole("status")
    expect(within(status).getByText("Live")).toBeInTheDocument()
    expect(within(status).getByText("OpenCode is running")).toBeInTheDocument()
    expect(status.querySelectorAll(".bg-finished")).toHaveLength(2)
  })

  it("tells a lost connection from data that cannot be read, and a stopped OpenCode from an unchecked one", async () => {
    const lost = renderHeader(snapshot({ opencodeRunning: false }), false)
    expect(await screen.findByText("Monitor not reachable — retrying")).toBeInTheDocument()
    expect(screen.getByText("OpenCode is not running")).toBeInTheDocument()
    expect(screen.getByRole("status").querySelectorAll(".bg-error")).toHaveLength(2)
    lost.unmount()

    renderHeader(snapshot({ stale: true, opencodeRunning: null }))
    expect(await screen.findByText(/Can't read OpenCode's data right now/)).toBeInTheDocument()
    expect(screen.getByText("OpenCode process not checked")).toBeInTheDocument()
  })

  it("yes, no and not known yet each have their own tone", () => {
    expect([toneOf(true), toneOf(false), toneOf(null), toneOf(undefined)]).toEqual(["ok", "bad", "unknown", "unknown"])
  })
})

describe("The environment strip", () => {
  const environment: NonNullable<Snapshot["environment"]> = {
    checkedAt: 1,
    models: [
      { name: "local-llama", target: "http://127.0.0.1:8080/v1", ok: true, ms: 22 },
      { name: "ollama", target: "http://127.0.0.1:11434/v1", ok: false, error: "timeout" },
      { name: "remote", target: "http://10.0.0.9/v1", ok: false, status: 503 },
      { name: "pending", target: "http://127.0.0.1:1/v1", ok: null },
    ],
    services: [],
    mcp: [
      { name: "graft", type: "local", scope: "global", status: "ok", kind: null, failedAt: null, lastOkAt: 1 },
      { name: "trivy", type: "local", scope: "global", status: "unknown", kind: null, failedAt: null, lastOkAt: null },
      { name: "memory", type: "local", scope: "global", status: "failed", kind: "closed", failedAt: 1, lastOkAt: null },
      { name: "github", type: "remote", scope: "global", status: "disabled", kind: null, failedAt: null, lastOkAt: null },
    ],
  }
  const renderStrip = (env: Snapshot["environment"]) =>
    render(
      <I18nProvider>
        <TooltipProvider>
          <Environment environment={env} />
        </TooltipProvider>
      </I18nProvider>
    )
  // The chip of one server: its dot, its name and the note beside it.
  const chip = (name: string) => screen.getByText(name).parentElement!

  it("gives each model server its answer time, or what went wrong", async () => {
    renderStrip(environment)
    expect(await screen.findByText("22 ms")).toBeInTheDocument()
    expect(chip("local-llama").querySelector(".bg-finished")).not.toBeNull()
    expect(within(chip("ollama")).getByText("timed out")).toBeInTheDocument()
    expect(chip("ollama").querySelector(".bg-error")).not.toBeNull()
    expect(within(chip("remote")).getByText("HTTP 503")).toBeInTheDocument()
    // Not checked yet: neither up nor down.
    expect(within(chip("pending")).getByText("…")).toBeInTheDocument()
    expect(chip("pending").querySelector(".bg-finished, .bg-error")).toBeNull()
  })

  it("says how an MCP server failed, stays quiet about one that works, and leaves out one that is off", async () => {
    renderStrip(environment)
    expect(await screen.findByText("graft")).toBeInTheDocument()
    expect(chip("graft").textContent).toBe("graft")
    expect(within(chip("trivy")).getByText("no signal")).toBeInTheDocument()
    expect(within(chip("memory")).getByText("connection closed")).toBeInTheDocument()
    expect(chip("memory").querySelector(".bg-error")).not.toBeNull()
    expect(screen.queryByText("github")).not.toBeInTheDocument()
    // No services are configured, so that row is not there.
    expect(screen.queryByText("Services")).not.toBeInTheDocument()
  })

  it("is left out when nothing has been checked", () => {
    const { container } = renderStrip(null)
    expect(container).toBeEmptyDOMElement()
  })
})
