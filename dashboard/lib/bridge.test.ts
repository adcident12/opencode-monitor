import { describe, expect, it } from "vitest"
import { crewAt, momentsOf, playedOf, rowsOf, tagOf, tallyOf, type Bridge } from "./bridge"
import { clockOf, figuresAt, stateAt, type Replay } from "./replay"

const T = 1_800_000_000_000
const s = (n: number) => T + n * 1000

const replay = (id: string, project: string, title: string, extra: Partial<Replay>): Replay => ({
  session: { id, title, project },
  start: s(0), end: s(1000), now: s(5000), stuckMs: 600_000,
  rows: [], moreSubagents: 0, turns: [], context: [], contextLimit: 131_072, compactAt: 99_072, compactions: [], plans: [],
  ...extra,
})

// Two sessions of one project and one of another, on a day that runs from 100 s to 2000 s.
const a = replay("a", "shop", "Checkout flow", {
  start: s(50), end: s(700),
  rows: [
    { id: "a", name: "build", title: "Checkout flow", sub: false, segs: [[s(50), s(150), "tool", "bash npm test"], [s(120), s(140), "waiting", "bash npm test"], [s(300), s(360), "compact", ""], [s(600), s(690), "writing", ""]] },
    { id: "a1", name: "explore", title: "Look", sub: true, segs: [[s(200), s(260), "tool", "read a.ts"]] },
  ],
  turns: [{ at: s(50), end: s(690), ending: "done" }],
  context: [[s(60), 30_000], [s(400), 12_000]],
  compactions: [s(300)],
})
const b = replay("b", "shop", "Fix the cart", {
  start: s(900), end: s(2500),
  rows: [{ id: "b", name: "build", title: "Fix the cart", sub: false, segs: [[s(900), s(2500), "tool", "bash sleep"]] }],
  turns: [{ at: s(900), end: s(2500), ending: "open" }],
  context: [[s(905), 50_000]],
})
const c = replay("c", "blog", "Write a post", { start: s(1500), end: s(1600), rows: [{ id: "c", name: "build", title: "Write a post", sub: false, segs: [[s(1500), s(1590), "thinking", ""]] }], turns: [{ at: s(1500), end: s(1590), ending: "error" }] })
const bridge: Bridge = { day: "2027-01-15", start: s(100), end: s(2000), now: s(5000), sessions: [a, b, c], more: 0 }

describe("The whole bridge, played back", () => {
  it("names a station by its folder, or by its title when two sessions share one", () => {
    expect(bridge.sessions.map(r => tagOf(r, bridge.sessions))).toEqual(["Checkout flow", "Fix the cart", "blog"])
    expect(tagOf(a, [a, c])).toBe("shop")
  })

  it("keeps to the day: what began before it or ran past it is cut at its ends", () => {
    const rows = rowsOf(bridge)
    expect(rows.map(r => [r.name, r.caption])).toEqual([["Checkout flow", "shop"], ["Fix the cart", "shop"], ["blog", "blog"]])
    // The call that began at 50 s starts with the day; the one still running at its end stops there.
    expect(rows[0].segs[0].slice(0, 2)).toEqual([s(100), s(150)])
    expect(rows[1].segs[0].slice(0, 2)).toEqual([s(900), s(2000)])
    // One row a session: a subagent's doings are in its session's own replay.
    expect(rows).toHaveLength(3)
  })

  it("skips a silence only when no session at all was doing anything", () => {
    const played = playedOf(bridge)
    expect([played.start, played.end]).toEqual([s(100), s(2000)])
    // Subagents count: 200-260 s is not silent, though the main agents were.
    expect(played.rows).toHaveLength(4)
    const gaps = clockOf(played as Replay, true).gaps
    expect(gaps).toEqual([[s(360), s(600)], [s(690), s(900)]])
  })

  it("gives each session, at a moment, what its own replay gives", () => {
    for (const t of [s(100), s(130), s(230), s(330), s(650), s(800), s(1000), s(1550), s(1700), s(1999)]) {
      const crew = crewAt(bridge, t)
      for (const member of crew) {
        const alone = stateAt(member.replay, t)
        expect([member.state, member.seg]).toEqual([alone.state, alone.seg])
        const figures = figuresAt(member.replay, t)
        expect(member.context).toBe(figures.context)
        expect(member.busy).toBe(figures.busy.length)
      }
    }
  })

  it("tells who had begun, who waited, and which subagent was at work", () => {
    const early = crewAt(bridge, s(130))
    expect(early.map(m => [m.state, m.begun])).toEqual([["waiting", true], ["idle", false], ["idle", false]])
    expect(tallyOf(early)).toEqual({ waiting: 1, stuck: 0, error: 0, working: 0, finished: 0, idle: 2 })
    expect(crewAt(bridge, s(230))[0]).toMatchObject({ state: "working", busy: 1, sub: { name: "explore" }, compactedAt: null })
    expect(crewAt(bridge, s(330))[0]).toMatchObject({ context: null, compactedAt: s(300) })
    const late = crewAt(bridge, s(1700))
    expect(late.map(m => m.state)).toEqual(["finished", "stuck", "error"])
    expect(tallyOf(late)).toEqual({ waiting: 0, stuck: 1, error: 1, working: 0, finished: 1, idle: 0 })
  })

  it("steps between the turns of the day, in order, across sessions: not every tool call", () => {
    const moments = momentsOf(bridge)
    expect(moments.map(m => [m.session, m.kind, (m.at - T) / 1000])).toEqual([
      ["a", "waiting", 120], ["a", "answered", 140], ["a", "compact", 300], ["a", "ended", 690],
      ["b", "prompt", 900], ["c", "prompt", 1500], ["c", "ended", 1590],
    ])
  })
})
