import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { TooltipProvider } from "@/components/ui/tooltip"
import { I18nProvider } from "@/lib/i18n"
import type { Session } from "@/lib/types"
import { AttentionCard } from "./sessions"

// Serve the real string files to the I18nProvider.
beforeEach(() => {
  vi.stubGlobal("fetch", async (url: string) => {
    const code = /\/i18n\/(\w+)\.json$/.exec(url)?.[1] ?? "en"
    return new Response(readFileSync(join(__dirname, "..", "..", "..", "i18n", `${code}.json`), "utf8"))
  })
  window.history.replaceState(null, "", "/?lang=en")
})

const NOW = 1_800_000_000_000

const waiting: Session = {
  id: "s1", parentId: null, title: "Wire up the staging environment", project: "clinic-app", directory: "/work/clinic-app",
  model: null, createdAt: NOW - 11 * 3_600_000, updatedAt: NOW, state: "waiting", reason: "permission", detail: null,
  since: NOW - (8 * 3600 + 10 * 60 + 42) * 1000, limitMs: null, current: null,
  prompt: { kind: "permission", permission: "read", detail: "/work/clinic-app/.env" },
  progress: { lastActivityAt: NOW - 8 * 3_600_000, steps: [], todos: null },
  health: { contextTokens: 54_000, contextLimit: 131_072, contextPct: 41, compactions: 0, toolCalls: 9, toolErrors: 0, lastError: null, repeat: null, hints: ["old_session"], suggestNewSession: true },
  work: { files: { count: 0, recent: [] }, git: { branch: "main", detached: false, state: "ok" }, warnProtected: true, warnUnknownBranch: false, running: { failed: false, items: [{ pid: 4242, pids: [4242, 4243], name: "cmd.exe", command: "cmd /c npm run dev", startedAt: NOW - 600_000, ports: [3000], processes: 2, from: "Start-Process npm -ArgumentList run,dev" }] } },
  review: {
    counts: { risky: 0, secret_value: 0, secret_file: 1, outbound: 0, background: 0 }, total: 1, more: 0, ignored: 0,
    items: [{ kind: "secret_file", rule: "secret_file", host: null, at: NOW, count: 1, approvals: { asked: 1, rule: 0, refused: 0 }, hiddenExamples: 0,
      examples: [{ tool: "read", text: "/work/clinic-app/.env", at: NOW, count: 1, approvals: { asked: 1, rule: 0, refused: 0 } }] }],
  },
}

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
