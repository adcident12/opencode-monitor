import { fireEvent, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { TooltipProvider } from "@/components/ui/tooltip"
import { I18nProvider } from "@/lib/i18n"
import type { Replay as ReplayData } from "@/lib/replay"
import { Replay } from "./replay"

const T = 1_800_000_000_000
const s = (n: number) => T + n * 1000
const replay: ReplayData = {
  session: { id: "ses_1", title: "Checkout flow", project: "shop" },
  start: s(0), end: s(1200), now: s(1300), stuckMs: 600_000,
  rows: [
    { id: "ses_1", name: "build", title: "Checkout flow", sub: false, segs: [[s(0), s(10), "reading", ""], [s(60), s(120), "tool", "bash npm test"], [s(70), s(100), "waiting", "bash npm test"], [s(1100), s(1190), "writing", ""]] },
    { id: "ses_2", name: "explore", title: "Look around", sub: true, segs: [[s(20), s(40), "tool", "read a.ts"]] },
  ],
  moreSubagents: 0,
  turns: [{ at: s(0), end: s(1190), ending: "done" }],
  context: [[s(1), 30_000]],
  contextLimit: 131_072,
  compactAt: 99_072,
  compactions: [],
  plans: [[s(5), [["Read the cart", "in_progress"], ["Fix the total", "pending"]]]],
}
let asked: string[] = []

beforeEach(() => {
  asked = []
  vi.stubGlobal("fetch", async (url: string) => {
    asked.push(url)
    if (url === "/api/replay/sessions") return Response.json([{ id: "ses_1", title: "Checkout flow", project: "shop" }, { id: "ses_9", title: "Older", project: "blog" }])
    if (url.startsWith("/api/replay?")) return Response.json(replay)
    const code = /\/i18n\/(\w+)\.json$/.exec(url)?.[1] ?? "en"
    return new Response(readFileSync(join(__dirname, "..", "..", "..", "i18n", `${code}.json`), "utf8"))
  })
  HTMLCanvasElement.prototype.getContext = (() => null) as unknown as HTMLCanvasElement["getContext"]
  window.matchMedia = ((query: string) => ({ matches: true, media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia
  window.history.replaceState(null, "", "/?lang=en")
})

const renderTab = (session: string | null = null, onSession = vi.fn()) =>
  render(
    <I18nProvider>
      <TooltipProvider>
        <Replay session={session} onSession={onSession} />
      </TooltipProvider>
    </I18nProvider>,
  )

describe("The Replay tab", () => {
  it("plays the most recent session when none is picked, and says it is a replay", async () => {
    renderTab()
    expect(await screen.findByRole("heading", { name: "Checkout flow" })).toBeInTheDocument()
    expect(asked).toContain("/api/replay?session=ses_1")
    expect(screen.getByText("Replay, not now")).toBeInTheDocument()
    // The same session in the other tabs.
    expect(screen.getByRole("link", { name: "Stats" })).toHaveAttribute("href", "#stats/ses_1")
    expect(screen.getByRole("link", { name: "History" })).toHaveAttribute("href", "#history/ses_1")
  })

  it("shows the moment the playhead is at: state, what it was doing, the figures, the plan", async () => {
    renderTab("ses_1")
    await screen.findByRole("heading", { name: "Checkout flow" })
    const moment = screen.getByRole("region", { name: "At this moment" })
    expect(within(moment).getByText("Working")).toBeInTheDocument()
    expect(within(moment).getByText("Reading the prompt")).toBeInTheDocument()

    // To 80 seconds in: the agent was waiting for your permission.
    fireEvent.change(screen.getByRole("slider", { name: "Where in the session" }), { target: { value: "80000" } })
    expect(within(moment).getByText("Waiting for you")).toBeInTheDocument()
    expect(within(moment).getByText("Waiting for you: bash npm test")).toBeInTheDocument()
    expect(within(moment).getByText("30k / 131k")).toBeInTheDocument()
    const story = screen.getByRole("region", { name: "The plan and what happened" })
    expect(within(story).getByText("Read the cart")).toBeInTheDocument()
    expect(within(story).getByText("Waited for you")).toBeInTheDocument()
  })

  it("skips silences by default, and plays real time when asked", async () => {
    renderTab("ses_1")
    await screen.findByRole("heading", { name: "Checkout flow" })
    expect(screen.getByText(/Silences skipped: 1/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole("switch"))
    expect(screen.getByText("Real time, silences included.")).toBeInTheDocument()
    expect(screen.getByRole("slider", { name: "Where in the session" })).toHaveAttribute("max", "1200000")
  })

  it("plays at real speed too, and the running time keeps one shape", async () => {
    renderTab("ses_1")
    await screen.findByRole("heading", { name: "Checkout flow" })
    const speed = screen.getByRole("combobox", { name: "Speed" })
    expect(speed).toHaveTextContent("60×")
    await userEvent.click(speed)
    expect((await screen.findAllByRole("option")).map(o => o.textContent)).toEqual(["1×", "1.5×", "2.5×", "3×", "30×", "60×", "180×"])
    await userEvent.click(screen.getByRole("option", { name: "1×" }))
    expect(speed).toHaveTextContent("1×")
    // 20 minutes with one silence of 16m 20s taken in 20 seconds: 4 minutes of playback.
    expect(screen.getByText("00:00 / 04:00")).toBeInTheDocument()
    fireEvent.change(screen.getByRole("slider", { name: "Where in the session" }), { target: { value: "80000" } })
    expect(screen.getByText("01:20 / 04:00")).toBeInTheDocument()
  })

  it("steps to what happens next, and back", async () => {
    renderTab("ses_1")
    await screen.findByRole("heading", { name: "Checkout flow" })
    const back = screen.getByRole("button", { name: "Back to what happened before" })
    const on = screen.getByRole("button", { name: "On to what happens next" })
    const moment = screen.getByRole("region", { name: "At this moment" })
    expect(back).toBeDisabled()
    // The prompt at 0 is where it starts; next the subagent's read at 20 s, then the main agent's bash at 60 s.
    await userEvent.click(on)
    expect(screen.getByText("00:20 / 04:00")).toBeInTheDocument()
    await userEvent.click(on)
    expect(screen.getByText("01:00 / 04:00")).toBeInTheDocument()
    expect(within(moment).getByText("Running a tool: bash npm test")).toBeInTheDocument()
    await userEvent.click(back)
    expect(screen.getByText("00:20 / 04:00")).toBeInTheDocument()
    // What the step lands on has happened: it heads the list, and its time leads back to it.
    const story = screen.getByRole("region", { name: "The plan and what happened" })
    const rows = within(story).getAllByRole("listitem").filter(li => within(li).queryByRole("button"))
    expect(rows[0]).toHaveTextContent("explore:")
    expect(rows[0]).toHaveTextContent("read a.ts")
    await userEvent.click(on)
    await userEvent.click(on)
    expect(screen.getByText("01:10 / 04:00")).toBeInTheDocument()
    await userEvent.click(within(within(story).getAllByRole("listitem").filter(li => within(li).queryByRole("button")).at(-1) as HTMLElement).getByRole("button"))
    expect(screen.getByText("00:00 / 04:00")).toBeInTheDocument()
  })

  it("picks another session through the list", async () => {
    const onSession = vi.fn()
    renderTab("ses_1", onSession)
    await screen.findByRole("heading", { name: "Checkout flow" })
    await userEvent.click(screen.getByRole("combobox", { name: "Session" }))
    await userEvent.click(await screen.findByRole("option", { name: /Older/ }))
    expect(onSession).toHaveBeenCalledWith("ses_9")
    // There is no "every session" to replay.
    expect(screen.queryByRole("option", { name: "All sessions" })).not.toBeInTheDocument()
  })
})
