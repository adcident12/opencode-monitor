import { describe, expect, it } from "vitest"
import { clock, duration, groupByUrgency, rough, stopwatch, topLevel } from "./format"
import type { Session, State } from "./types"

const session = (id: string, state: State, extra: Partial<Session> = {}) => ({ id, parentId: null, state, updatedAt: 0, ...extra }) as Session

describe("time formatting", () => {
  it("clock", () => {
    expect(clock(43_000)).toBe("0:43")
    expect(clock(12 * 60_000 + 5_000)).toBe("12:05")
    expect(clock((8 * 3600 + 10 * 60 + 42) * 1000)).toBe("8:10:42")
    expect(clock(50 * 3_600_000)).toBe("2d 2h")
    expect(clock(-5)).toBe("0:00")
  })
  it("duration and rough", () => {
    expect(duration(45_000)).toBe("45s")
    // A stopwatch is as wide at the first second as at the last.
    expect([stopwatch(0, 2_420_000), stopwatch(247_900, 2_420_000), stopwatch(2_420_000)]).toEqual(["00:00", "04:07", "40:20"])
    expect([stopwatch(0, 3_847_000), stopwatch(3_847_000)]).toEqual(["0:00:00", "1:04:07"])
    expect(stopwatch(5_000, 30 * 3_600_000)).toBe("00:00:05")
    expect(duration(12 * 60_000 + 5_000)).toBe("12m 05s")
    expect(duration(3 * 3_600_000 + 20 * 60_000)).toBe("3h 20m")
    expect(rough(10 * 60_000)).toBe("10m")
    expect(rough(2 * 3_600_000 + 5 * 60_000)).toBe("2h 5m")
  })
})

describe("grouping", () => {
  it("puts what needs the user first and hides subagents under their parent", () => {
    const list = [
      session("done", "finished", { updatedAt: 5 }),
      session("busy", "working"),
      session("child", "waiting", { parentId: "parent" }),
      session("parent", "waiting"),
      session("broken", "error", { updatedAt: 9 }),
      session("orphan", "stuck", { parentId: "gone" }),
    ]
    expect(topLevel(list).map(s => s.id)).toEqual(["parent", "orphan", "broken", "busy", "done"])
    const groups = groupByUrgency(list)
    expect(groups.attention.map(s => s.id)).toEqual(["parent", "orphan", "broken"])
    expect(groups.working.map(s => s.id)).toEqual(["busy"])
    expect(groups.rest.map(s => s.id)).toEqual(["done"])
  })
})
