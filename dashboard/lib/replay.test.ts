import { describe, expect, it } from "vitest"
import { clockOf, eventsOf, figuresAt, screenAt, segAt, silencesOf, SKIPPED_MS, stateAt, type Replay } from "./replay"

const T = 1_800_000_000_000
const s = (n: number) => T + n * 1000
const min = 60_000

const replay = (extra: Partial<Replay> = {}): Replay => ({
  session: { id: "root", title: "Checkout flow", project: "shop" },
  start: s(0),
  end: s(1200),
  now: s(1300),
  stuckMs: 10 * min,
  rows: [
    {
      id: "root", name: "build", title: "Checkout flow", sub: false,
      segs: [[s(0), s(10), "reading", ""], [s(10), s(60), "thinking", ""], [s(60), s(120), "tool", "bash npm test"], [s(70), s(100), "waiting", "bash npm test"],
        [s(130), s(140), "compact", ""],
        // you were away for 15 minutes
        [s(1100), s(1190), "writing", ""]],
    },
    { id: "kid", name: "explore", title: "Look around", sub: true, segs: [[s(20), s(40), "tool", "read a.ts"]] },
  ],
  moreSubagents: 0,
  turns: [{ at: s(0), end: s(150), ending: "continued" }, { at: s(1090), end: s(1190), ending: "done" }],
  context: [[s(1), 30_000], [s(1095), 45_000]],
  contextLimit: 131_072,
  compactAt: 99_072,
  compactions: [s(130)],
  plans: [[s(5), [["Read the cart", "in_progress"]]], [s(1150), [["Read the cart", "completed"]]]],
  ...extra,
})

describe("Skipping the silences", () => {
  it("finds the stretches longer than two minutes where nothing happens", () => {
    expect(silencesOf(replay())).toEqual([[s(140), s(1100)]])
  })

  it("plays a silence in twenty seconds, and maps both ways", () => {
    const r = replay()
    const skip = clockOf(r, true)
    expect(skip).toHaveLength(1200_000 - (960_000 - SKIPPED_MS))
    const real = clockOf(r, false)
    expect(real).toHaveLength(1200_000)
    for (const t of [s(0), s(100), s(140), s(600), s(1100), s(1150), s(1200)]) {
      expect(skip.toReal(skip.toPlay(t))).toBeCloseTo(t, -1)
      expect(real.toPlay(t)).toBe(t - T)
    }
    // Halfway through the silence in playback is halfway through it in real time.
    expect(skip.toReal(140_000 + SKIPPED_MS / 2)).toBe(s(620))
    // Past the silence, playback runs at real speed again.
    expect(skip.toReal(skip.toPlay(s(1150)) + 10_000)).toBe(s(1160))
  })
})

describe("A moment of the session", () => {
  it("shows the most telling thing open: waiting over the tool that waits", () => {
    const row = replay().rows[0]
    expect(segAt(row, s(80))?.[2]).toBe("waiting")
    expect(segAt(row, s(110))?.[2]).toBe("tool")
    expect(segAt(row, s(125))).toBeNull()
  })

  it("is in the state the Now tab would have shown", () => {
    const r = replay()
    expect(stateAt(r, s(80)).state).toBe("waiting")
    expect(stateAt(r, s(110)).state).toBe("working")
    // Between two steps of a prompt: still working.
    expect(stateAt(r, s(125)).state).toBe("working")
    // The first prompt was followed by another: working until then; the second ended done.
    expect(stateAt(r, s(1195)).state).toBe("finished")
    // A call running longer than the stuck limit.
    const long = replay({ rows: [{ ...r.rows[0], segs: [[s(0), s(900), "tool", "bash npm run build"]] }] })
    expect(stateAt(long, s(700)).state).toBe("stuck")
  })

  it("puts the tool on the screen, and the state first", () => {
    const r = replay()
    expect(screenAt("working", segAt(r.rows[0], s(110)))).toBe("shell")
    expect(screenAt("working", segAt(r.rows[0], s(135)))).toBe("compact")
    expect(screenAt("working", [s(0), s(1), "tool", "context7_query-docs x"])).toBe("web")
    expect(screenAt("working", [s(0), s(1), "tool", "edit a.ts"])).toBe("code")
    // The live bridge and a replay show the same screen for the same tool.
    expect(screenAt("working", [s(0), s(1), "tool", "fetch https://example.com"])).toBe("web")
    expect(screenAt("working", null)).toBe("think")
    expect(screenAt("waiting", null)).toBe("ask")
    expect(screenAt("finished", null)).toBe("done")
  })

  it("has the figures of that moment", () => {
    const r = replay()
    const at = figuresAt(r, s(110))
    expect(at).toMatchObject({ context: 30_000, toolCalls: 2, waitedMs: 30_000, compactions: 0 })
    expect(at.plan).toEqual([["Read the cart", "in_progress"]])
    expect(figuresAt(r, s(30)).busy.map(x => x.name)).toEqual(["explore"])
    // While compacting the old size is not shown as if it were current.
    expect(figuresAt(r, s(135))).toMatchObject({ context: null, compacting: true })
    // Before the first request there is no size yet, and nothing is being compacted.
    expect(figuresAt(r, s(0))).toMatchObject({ context: null, compacting: false })
    expect(figuresAt(r, s(1160))).toMatchObject({ context: 45_000, compactions: 1, plan: [["Read the cart", "completed"]] })
  })

  it("a task list written is a change of plan, not a tool run", () => {
    const r = replay({ rows: [{ ...replay().rows[0], segs: [[s(5), s(6), "tool", "todowrite {}"]] }] })
    expect(eventsOf(r).find(e => e.at === s(5))).toMatchObject({ kind: "plan", text: "" })
  })

  it("lists what happened in order", () => {
    const kinds = eventsOf(replay()).map(e => [(e.at - T) / 1000, e.kind, e.row])
    expect(kinds).toEqual([
      [0, "prompt", ""], [20, "tool", "explore"], [60, "tool", ""], [70, "waiting", ""], [100, "answered", ""], [130, "compact", ""],
      [1090, "prompt", ""], [1190, "ended", ""],
    ])
  })
})
