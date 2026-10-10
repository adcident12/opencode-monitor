import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { TooltipProvider } from "@/components/ui/tooltip"
import { I18nProvider } from "@/lib/i18n"
import { NOW, waiting } from "@/lib/fixtures"
import { AttentionCard } from "./sessions"

// Serve the real string files to the I18nProvider.
beforeEach(() => {
  vi.stubGlobal("fetch", async (url: string) => {
    const code = /\/i18n\/(\w+)\.json$/.exec(url)?.[1] ?? "en"
    return new Response(readFileSync(join(__dirname, "..", "..", "..", "i18n", `${code}.json`), "utf8"))
  })
  window.history.replaceState(null, "", "/?lang=en")
})


function renderCard() {
  return render(
    <I18nProvider>
      <TooltipProvider>
        <AttentionCard session={waiting} subagents={[]} now={NOW} />
      </TooltipProvider>
    </I18nProvider>,
  )
}

describe("AttentionCard", () => {
  it("leads with how long it has been waiting, and what for", async () => {
    renderCard()
    expect(await screen.findByText("Needs permission: read")).toBeInTheDocument()
    expect(screen.getByText("8:10:42")).toBeInTheDocument()
    expect(screen.getByText("waiting for you")).toBeInTheDocument()
    expect(screen.getAllByText("/work/clinic-app/.env").length).toBeGreaterThan(0)
    expect(screen.getByText("Consider starting a new session.")).toBeInTheDocument()
  })

  it("says how much room is left before OpenCode compacts, and warns when it is close", async () => {
    renderCard()
    expect(await screen.findByText("44k left before it is compacted · about 8 requests at this pace")).toBeInTheDocument()

    render(
      <I18nProvider>
        <TooltipProvider>
          <AttentionCard
            session={{ ...waiting, id: "s2", health: { ...waiting.health, hints: ["context_high"], compaction: { at: 99_072, room: 9_000, growth: 6000, requestsLeft: 1 } } }}
            subagents={[]}
            now={NOW}
          />
        </TooltipProvider>
      </I18nProvider>,
    )
    expect(await screen.findByText("About 9k tokens left before OpenCode compacts this session and forgets the details (requests left at this pace: about 1).")).toBeInTheDocument()
  })

  it("keeps work and review folded until asked, and opens them on click", async () => {
    renderCard()
    const review = await screen.findByRole("button", { name: /To review/ })
    expect(review).toHaveAttribute("aria-expanded", "false")
    await userEvent.click(review)
    expect(review).toHaveAttribute("aria-expanded", "true")
    expect(await screen.findByText("Touches a secret file")).toBeInTheDocument()

    await userEvent.click(screen.getByRole("button", { name: /^Work/ }))
    expect(await screen.findByText(/This session is working directly on main/)).toBeInTheDocument()
    // The leftover dev server: named, with its port, and how to stop it by hand.
    expect(screen.getByText("1 still running")).toBeInTheDocument()
    expect(screen.getByText("PID 4242")).toBeInTheDocument()
    expect(screen.getByText("listening on 3000")).toBeInTheDocument()
    expect(screen.getByText(/taskkill \/PID 4242|kill 4242/)).toBeInTheDocument()
  })

  it("links to this session's own stats, and to its history only when history is kept", async () => {
    renderCard()
    expect(await screen.findByRole("link", { name: "Stats" })).toHaveAttribute("href", "#stats/s1")
    expect(screen.queryByRole("link", { name: "History" })).not.toBeInTheDocument()

    render(
      <I18nProvider>
        <TooltipProvider>
          <AttentionCard session={{ ...waiting, id: "s1-sub", parentId: "s1" }} subagents={[]} now={NOW} history />
        </TooltipProvider>
      </I18nProvider>,
    )
    // A subagent points at its parent: that is where its entries are recorded.
    expect(await screen.findByRole("link", { name: "History" })).toHaveAttribute("href", "#history/s1")
  })
})
