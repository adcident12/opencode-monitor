import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { TooltipProvider } from "@/components/ui/tooltip"
import { NOW, waiting } from "@/lib/fixtures"
import { I18nProvider } from "@/lib/i18n"
import type { Session, Snapshot } from "@/lib/types"
import { Ship } from "./ship"

beforeEach(() => {
  vi.stubGlobal("fetch", async (url: string) => {
    const code = /\/i18n\/(\w+)\.json$/.exec(url)?.[1] ?? "en"
    return new Response(readFileSync(join(__dirname, "..", "..", "..", "i18n", `${code}.json`), "utf8"))
  })
  // jsdom draws nothing; the picture is not what is tested here, what it says is.
  HTMLCanvasElement.prototype.getContext = (() => null) as unknown as HTMLCanvasElement["getContext"]
  // A wide screen, and no wish for less motion.
  window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia
  window.history.replaceState(null, "", "/?lang=en")
})

const LONG = "a-project-folder-with-an-extremely-long-name-that-would-never-fit-on-a-name-tag"
const sessions: Session[] = [
  { ...waiting, id: "w", project: LONG },
  { ...waiting, id: "b", state: "working", reason: "tool", prompt: null, title: "Build the checkout", project: "shop", current: { tool: "bash", summary: "npm test", startedAt: NOW, output: null } },
  { ...waiting, id: "b-sub", parentId: "b", state: "working", prompt: null, title: "explore", project: "shop" },
  { ...waiting, id: "f", state: "finished", reason: "done", prompt: null, title: "Rate limiter", project: "api" },
]
const snapshot = (list: Session[] = sessions): Snapshot => ({
  now: NOW, opencodeRunning: true, stale: false, lookbackHours: 24, sessions: list, historyCount: null,
  environment: { checkedAt: 1, models: [], services: [], mcp: [] },
  build: null, version: null, opencodeVersion: null, opencodeTested: null, opencodeUntested: false,
})
const renderShip = (snap = snapshot()) =>
  render(
    <I18nProvider>
      <TooltipProvider>
        <Ship snapshot={snap} now={NOW} history={false} />
      </TooltipProvider>
    </I18nProvider>,
  )

describe("The bridge", () => {
  it("has one station per session, the ones that need you first, and none for subagents", async () => {
    renderShip()
    const stations = within(await screen.findByRole("list", { name: "The bridge: 3 sessions, one crew member each" })).getAllByRole("button")
    expect(stations.map(b => b.getAttribute("aria-label"))).toEqual([
      `${LONG}: Waiting for you. Wire up the staging environment`,
      "shop: Working. Build the checkout",
      "api: Finished. Rate limiter",
    ])
  })

  it("a long name is cut short on its tag, and given in full where it can be read", async () => {
    renderShip()
    const first = (await screen.findAllByRole("button", { pressed: true }))[0]
    const tag = within(first).getByText(LONG)
    expect(tag).toHaveClass("truncate")
    expect(first).toHaveAttribute("title", `${LONG} — Wire up the staging environment`)
  })

  it("over a station, a few words say its state; a working one has none", async () => {
    renderShip()
    expect(await screen.findByText("Needs you!")).toBeInTheDocument()
    expect(screen.getByText("Done")).toBeInTheDocument()
    const busy = screen.getByRole("button", { name: /^shop:/ })
    expect(within(busy).queryByText(/!/)).not.toBeInTheDocument()
  })

  it("shows the card of the most urgent station, and of another when it is picked", async () => {
    renderShip()
    const picked = await screen.findByRole("region", { name: "The session at the station you picked" })
    expect(within(picked).getByText("Needs permission: read")).toBeInTheDocument()

    await userEvent.click(screen.getByRole("button", { name: /^shop:/ }))
    expect(screen.getByRole("button", { name: /^shop:/ })).toHaveAttribute("aria-pressed", "true")
    const card = screen.getByRole("region", { name: "The session at the station you picked" })
    expect(within(card).getByText("Build the checkout")).toBeInTheDocument()
    // Its subagent is listed on the card, as on the Cards view.
    expect(within(card).getByText("explore")).toBeInTheDocument()
  })

  it("says what the pictures mean, on request", async () => {
    renderShip()
    await userEvent.click(await screen.findByRole("button", { name: "What the bridge shows" }))
    expect(screen.getByText("Fuel gauge")).toBeInTheDocument()
    expect(screen.getByText(/The white tick is where OpenCode compacts/)).toBeInTheDocument()
  })

  it("with more sessions than stations, says how many are left off", async () => {
    const many = Array.from({ length: 14 }, (_, i) => ({ ...waiting, id: `s${i}`, state: "finished" as const, prompt: null, project: `p${i}` }))
    renderShip(snapshot(many))
    expect(await screen.findByText("2 more sessions are not on the bridge; Cards shows them all.")).toBeInTheDocument()
  })
})
