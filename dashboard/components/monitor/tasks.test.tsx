import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { I18nProvider } from "@/lib/i18n"
import type { Overnight, Tasks as TasksData, TaskSession } from "@/lib/types"
import { Tasks } from "./tasks"

const NOW = 1_800_000_000_000
const HOUR = 3_600_000

const session = (id: string, title: string, extra: Partial<TaskSession> = {}): TaskSession => ({
  id, title, createdAt: NOW - 5 * HOUR, lastAt: NOW - HOUR, ended: "stopped", open: false, plan: null, left: [], more: 0, ...extra,
})

const data: TasksData = {
  range: { from: NOW - 7 * 24 * HOUR, to: NOW, days: 7 },
  total: 3,
  open: 1,
  projects: [
    {
      project: "shop", directory: "/work/shop", lastAt: NOW - HOUR, open: 1,
      sessions: [
        session("ses_half", "Services page", {
          open: true, plan: { done: 1, total: 8 },
          left: Array.from({ length: 7 }, (_, i) => ({ content: `Step ${i + 2}`, status: i === 0 ? "in_progress" : "pending" })),
        }),
        session("ses_done", "Checkout", { plan: { done: 3, total: 3 } }),
      ],
    },
    { project: "blog", directory: "/work/blog", lastAt: NOW - 2 * HOUR, open: 0, sessions: [session("ses_typo", "Typo")] },
  ],
}

// 22:00 to 08:00; the model server went down at 03:35 and nothing ran until morning.
const NIGHT = new Date(2026, 9, 12, 22, 0).getTime()
const night: Overnight = {
  from: NIGHT, to: NIGHT + 10 * HOUR, going: false, recorded: true,
  sessions: [
    { id: "ses_half", title: "Services page", project: "shop", state: "error", since: NIGHT + 5.5 * HOUR + 5 * 60_000, reason: "message_error", permission: null, error: "ConnectionRefused", limitMs: null, workedMs: 5.5 * HOUR, waitedMs: 4.5 * HOUR, plan: { done: 1, total: 8 }, left: 7, unfinished: true },
  ],
  totals: { sessions: 1, finished: 0, unfinished: 1, working: 0, workedMs: 5.5 * HOUR, waitedMs: 4.5 * HOUR, stillMs: 4 * HOUR + 25 * 60_000, longestStill: { from: NIGHT + 5.5 * HOUR + 5 * 60_000, to: NIGHT + 10 * HOUR, ms: 4 * HOUR + 25 * 60_000 } },
}

let requested: string[] = []

beforeEach(() => {
  requested = []
  vi.stubGlobal("fetch", async (url: string) => {
    requested.push(url)
    if (url.startsWith("/api/tasks")) return Response.json(data)
    if (url.startsWith("/api/overnight")) return Response.json(night)
    const code = /\/i18n\/(\w+)\.json$/.exec(url)?.[1] ?? "en"
    return new Response(readFileSync(join(__dirname, "..", "..", "..", "i18n", `${code}.json`), "utf8"))
  })
  window.history.replaceState(null, "", "/?lang=en")
})

const renderTasks = () =>
  render(
    <I18nProvider>
      <Tasks />
    </I18nProvider>,
  )

describe("Tasks", () => {
  it("lists sessions by project, with how far each plan got and what is left", async () => {
    renderTasks()
    expect(await screen.findByText("1 of 3 sessions unfinished")).toBeTruthy()
    expect(requested).toContain("/api/tasks?days=7")
    expect(screen.getByRole("heading", { name: "shop" })).toBeTruthy()
    expect(screen.getByText("1 unfinished")).toBeTruthy()
    expect(screen.getAllByText("Plan 1/8").length).toBeGreaterThan(0)
    // The first five items, then a way to the rest.
    expect(screen.getByText("Step 6")).toBeTruthy()
    expect(screen.queryByText("Step 7")).toBeNull()
    await userEvent.click(screen.getByRole("button", { name: "2 more" }))
    expect(screen.getByText("Step 8")).toBeTruthy()
    expect(screen.getByLabelText("in progress")).toBeTruthy()
  })

  it("says what happened while you were away, and the hours nothing ran", async () => {
    renderTasks()
    expect(await screen.findByText("1 session overnight · the agent worked 5h 30m · 0 finished, 1 need you or stopped part done, 0 still working")).toBeTruthy()
    expect(screen.getByText("Nothing ran from 03:35 to 08:00 (4h 25m) while a session needed you.")).toBeTruthy()
    expect(screen.getByText("The model request failed (ConnectionRefused)")).toBeTruthy()
    expect(screen.getByText("plan 1/8")).toBeTruthy()
  })

  it("can show only what is unfinished", async () => {
    renderTasks()
    // The night above lists it too: the Tasks list is the shop section.
    const shop = await screen.findByRole("region", { name: "shop" })
    expect(within(shop).getByText("Services page")).toBeTruthy()
    expect(screen.getByText("Typo")).toBeTruthy()
    await userEvent.click(screen.getByRole("button", { name: "Unfinished only" }))
    expect(screen.queryByText("Typo")).toBeNull()
    expect(screen.queryByText("Checkout")).toBeNull()
    expect(within(screen.getByRole("region", { name: "shop" })).getByText("Services page")).toBeTruthy()
  })
})
