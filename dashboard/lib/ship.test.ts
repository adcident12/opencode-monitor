import { describe, expect, it } from "vitest"
import { NOW, waiting } from "./fixtures"
import { bubbleOf, crewOf, dronesOf, fuelOf, layout, lookOf, MAX_STATIONS, screenOf } from "./ship"
import type { Session } from "./types"

const as = (extra: Partial<Session>): Session => ({ ...waiting, ...extra })
const working = (tool: string | null, extra: Partial<Session> = {}) =>
  as({ state: "working", reason: "tool", prompt: null, current: tool ? { tool, summary: "", startedAt: NOW, output: null } : null, ...extra })
const t = (key: string, vars: Record<string, string | number> = {}) => `${key}${vars.t ? ` ${vars.t}` : ""}`

describe("Who is on the bridge", () => {
  it("puts the sessions that need you first, then the busy ones, then the rest; subagents are not crew", () => {
    const sessions = [
      as({ id: "done", state: "finished" }),
      working("bash", { id: "busy" }),
      as({ id: "wait", state: "waiting" }),
      working("read", { id: "child", parentId: "busy" }),
    ]
    expect(crewOf(sessions).crew.map(s => s.id)).toEqual(["wait", "busy", "done"])
  })

  it("leaves no session out silently: past the last station they are counted", () => {
    const many = Array.from({ length: MAX_STATIONS + 3 }, (_, i) => as({ id: `s${i}`, state: "finished" }))
    expect(crewOf(many)).toMatchObject({ more: 3 })
    expect(crewOf(many).crew).toHaveLength(MAX_STATIONS)
  })

  it("three stations to a row, or two on a phone, centred, and as many rows as needed", () => {
    const one = layout(1)
    const seven = layout(7)
    // Centred: the margin left of the first column equals the one right of the last.
    expect(one.stations[0].x).toBe(one.width - 3 * 104 - one.stations[0].x)
    expect(seven.stations.map(s => s.y)).toEqual([50, 50, 50, 114, 114, 114, 178])
    expect(seven.height).toBeGreaterThan(one.height)
    const phone = layout(7, 2)
    expect(phone.stations.map(s => s.y)).toEqual([50, 50, 114, 114, 178, 178, 242])
    expect(phone.width).toBeLessThan(seven.width)
    // Every station fits inside the picture.
    for (const { stations, width } of [seven, phone]) for (const s of stations) expect(s.x + 104).toBeLessThanOrEqual(width)
  })

  it("the same session always gets the same look", () => {
    expect(lookOf("ses_abc")).toEqual(lookOf("ses_abc"))
    expect(Object.values(lookOf("ses_abc")).every(n => n >= 0 && n < 6)).toBe(true)
  })
})

describe("What a station shows", () => {
  it("the state first, then the tool that is running", () => {
    expect(screenOf(as({ state: "waiting" }))).toBe("ask")
    expect(screenOf(as({ state: "stuck" }))).toBe("wait")
    expect(screenOf(as({ state: "error" }))).toBe("fail")
    expect(screenOf(as({ state: "finished" }))).toBe("done")
    expect(screenOf(as({ state: "idle" }))).toBe("off")
    expect(screenOf(working("bash"))).toBe("shell")
    expect(screenOf(working("edit"))).toBe("code")
    expect(screenOf(working("grep"))).toBe("read")
    expect(screenOf(working("webfetch"))).toBe("web")
    // An MCP tool: <server>_<tool>.
    expect(screenOf(working("context7_query-docs"))).toBe("web")
    expect(screenOf(working("task"))).toBe("task")
    expect(screenOf(working(null))).toBe("think")
    expect(screenOf(working(null, { reason: "compacting" }))).toBe("compact")
  })

  it("the fuel gauge is the context, with a tick where OpenCode compacts", () => {
    expect(fuelOf(as({}))).toEqual({ fill: 54_000 / 131_072, tick: 99_072 / 131_072, high: false })
    // While compacting, the old size is not shown as if it were current.
    expect(fuelOf(as({ health: { ...waiting.health, compacting: true } })).fill).toBeNull()
    expect(fuelOf(as({ health: { ...waiting.health, contextLimit: null, compaction: null } }))).toMatchObject({ fill: null, tick: null })
    expect(fuelOf(as({ health: { ...waiting.health, hints: ["context_high"] } })).high).toBe(true)
  })

  it("the bubble says the state in a few words, and nothing from the session itself", () => {
    const minutes = () => "14m"
    expect(bubbleOf(as({}), NOW, t, minutes)).toBe("ship.bubble.waiting")
    expect(bubbleOf(as({ prompt: { kind: "question", permission: null, detail: "A very long question the agent asked…" } }), NOW, t, minutes)).toBe("ship.bubble.question")
    expect(bubbleOf(as({ state: "stuck" }), NOW, t, minutes)).toBe("ship.bubble.stuck 14m")
    expect(bubbleOf(as({ state: "error" }), NOW, t, minutes)).toBe("ship.bubble.error")
    expect(bubbleOf(as({ state: "finished" }), NOW, t, minutes)).toBe("ship.bubble.finished")
    expect(bubbleOf(working("bash"), NOW, t, minutes)).toBeNull()
    expect(bubbleOf(as({ state: "idle" }), NOW, t, minutes)).toBeNull()
  })

  it("drones are the subagents still at it, two drawn and the rest counted", () => {
    const kids = ["working", "waiting", "stuck", "finished"].map((state, i) => as({ id: `k${i}`, parentId: "p", state: state as Session["state"] }))
    expect(dronesOf(kids, "p")).toMatchObject({ more: 1 })
    expect(dronesOf(kids, "p").shown.map(s => s.id)).toEqual(["k0", "k1"])
    expect(dronesOf(kids, "nobody")).toEqual({ shown: [], more: 0 })
  })
})
