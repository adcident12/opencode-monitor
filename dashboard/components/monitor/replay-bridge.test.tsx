import { fireEvent, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { TooltipProvider } from "@/components/ui/tooltip"
import type { Bridge } from "@/lib/bridge"
import { I18nProvider } from "@/lib/i18n"
import type { Replay as ReplayData } from "@/lib/replay"
import { Replay } from "./replay"

// A day from local midnight, as the monitor's own days are.
const DAY = new Date(2027, 0, 15).getTime()
const s = (n: number) => DAY + 9 * 3_600_000 + n * 1000
const one = (id: string, project: string, title: string, extra: Partial<ReplayData>): ReplayData => ({
  session: { id, title, project },
  start: s(0), end: s(600), now: DAY + 86_400_000 * 2, stuckMs: 600_000,
  rows: [], moreSubagents: 0, turns: [], context: [], contextLimit: 131_072, compactAt: 99_072, compactions: [], plans: [],
  ...extra,
})
const bridge: Bridge = {
  day: "2027-01-15", start: DAY, end: DAY + 86_400_000, now: DAY + 86_400_000 * 2, more: 2,
  sessions: [
    one("ses_a", "shop", "Checkout flow", { rows: [{ id: "ses_a", name: "build", title: "", sub: false, segs: [[s(0), s(100), "tool", "bash npm test"], [s(20), s(60), "waiting", "bash npm test"]] }], turns: [{ at: s(0), end: s(100), ending: "done" }], context: [[s(1), 30_000]] }),
    one("ses_b", "shop", "Fix the cart", { start: s(300), rows: [{ id: "ses_b", name: "build", title: "", sub: false, segs: [[s(300), s(400), "thinking", ""]] }], turns: [{ at: s(300), end: s(400), ending: "done" }] }),
  ],
}

beforeEach(() => {
  vi.stubGlobal("fetch", async (url: string) => {
    if (url === "/api/replay/days") return Response.json([{ day: "2027-01-15", sessions: 4 }, { day: "2027-01-14", sessions: 1 }])
    if (url.startsWith("/api/replay/bridge")) return Response.json(bridge)
    if (url === "/api/replay/sessions") return Response.json([{ id: "ses_a", title: "Checkout flow", project: "shop" }])
    if (url.startsWith("/api/replay?")) return Response.json(bridge.sessions[0])
    const code = /\/i18n\/(\w+)\.json$/.exec(url)?.[1] ?? "en"
    return new Response(readFileSync(join(__dirname, "..", "..", "..", "i18n", `${code}.json`), "utf8"))
  })
  HTMLCanvasElement.prototype.getContext = (() => null) as unknown as HTMLCanvasElement["getContext"]
  window.matchMedia = ((query: string) => ({ matches: true, media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia
  window.history.replaceState(null, "", "/?lang=en")
})

async function openBridge(onSession = vi.fn()) {
  render(
    <I18nProvider>
      <TooltipProvider>
        <Replay session={null} onSession={onSession} />
      </TooltipProvider>
    </I18nProvider>,
  )
  await userEvent.click(await screen.findByRole("button", { name: "The whole bridge" }))
  await screen.findByRole("heading", { name: /January 15, 2027|15 January 2027/ })
  return onSession
}
const seek = (seconds: number) => fireEvent.change(screen.getByRole("slider", { name: "Where in the session" }), { target: { value: String(seconds * 1000) } })

describe("The whole bridge, played back", () => {
  it("plays the newest day, says it is a replay, and how many sessions it has and leaves off", async () => {
    await openBridge()
    expect(screen.getByText("Replay, not now")).toBeInTheDocument()
    expect(screen.getByText("Sessions that day: 4")).toBeInTheDocument()
    expect(screen.getByText("Not on the bridge for want of room: 2 more of that day.")).toBeInTheDocument()
    // Two sessions of one folder: told apart by their titles.
    const stations = within(screen.getByRole("list", { name: "The bridge at this moment" })).getAllByRole("button")
    expect(stations.map(b => b.getAttribute("aria-label"))).toEqual(["Checkout flow: Idle. Open its replay", "Fix the cart: Idle. Open its replay"])
  })

  it("shows every session at the moment the playhead is at", async () => {
    await openBridge()
    // Nothing happened from midnight to nine: the night is skipped, in twenty seconds.
    // Also the three minutes between the two sessions, and the rest of the day after them.
    expect(screen.getByText(/Silences skipped: 3/)).toBeInTheDocument()
    const each = screen.getByRole("region", { name: "Each session at this moment" })
    const rows = () => within(each).getAllByRole("listitem")
    expect(rows().map(li => li.textContent)).toEqual([expect.stringContaining("Not begun yet"), expect.stringContaining("Not begun yet")])

    // 20 seconds of skipped night, then 30 seconds into the first session: it waits for you.
    seek(20 + 30)
    expect(rows()[0]).toHaveTextContent("Waiting for you: bash npm test")
    expect(rows()[1]).toHaveTextContent("Not begun yet")
    const tally = within(screen.getByRole("list", { name: "How many sessions in each state" })).getAllByRole("listitem")
    expect(tally.map(li => li.textContent)).toEqual(["Waiting for you1", "Probably stuck0", "Error0", "Working0", "Finished0", "Idle1"])
    expect(within(screen.getByRole("list", { name: "The bridge at this moment" })).getAllByRole("button")[0]).toHaveAccessibleName("Checkout flow: Waiting for you. Open its replay")

    // Later: the first has finished, the second is thinking.
    // 100 seconds of the first session, the silence between in twenty, fifty into the second.
    seek(20 + 100 + 20 + 50)
    expect(rows().map(li => li.textContent)).toEqual([expect.stringContaining("Finished its turn"), expect.stringContaining("Thinking")])
  })

  it("steps between the turns of the day, and a station leads to its session's own replay", async () => {
    const onSession = await openBridge()
    const next = screen.getByRole("button", { name: "On to what happens next" })
    const each = screen.getByRole("region", { name: "Each session at this moment" })
    // The first prompt, then the wait, across both sessions in order.
    await userEvent.click(next)
    await userEvent.click(next)
    expect(within(each).getAllByRole("listitem")[0]).toHaveTextContent("Waiting for you")

    await userEvent.click(within(screen.getByRole("list", { name: "The bridge at this moment" })).getAllByRole("button")[1])
    expect(onSession).toHaveBeenCalledWith("ses_b")
    // Back to one session: its own player, not the bridge.
    expect(await screen.findByRole("heading", { name: "Checkout flow" })).toBeInTheDocument()
    expect(screen.queryByRole("list", { name: "The bridge at this moment" })).not.toBeInTheDocument()
  })
})
