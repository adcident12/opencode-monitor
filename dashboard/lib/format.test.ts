import { describe, expect, it } from "vitest"
import { clock, duration, groupByUrgency, rough, topLevel } from "./format"
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
