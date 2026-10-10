import { describe, expect, it } from "vitest"
import { layout } from "./ship"
import { drawShip, type Scene, type Station } from "./ship-draw"

// A context that keeps what was drawn: each pixel run as [x, y, w, h, colour].
function recorder() {
  const runs: [number, number, number, number, string][] = []
  const g = {
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    fillRect(x: number, y: number, w: number, h: number) {
      runs.push([x, y, w, h, String(this.fillStyle)])
    },
    beginPath() {},
    arc() {},
    fill() {},
    setLineDash() {},
    strokes: 0,
    strokeRect() {
      this.strokes++
    },
  }
  return { g, runs }
}

const station = (extra: Partial<Station> = {}): Station => ({
  x: 4, y: 50, screen: "think", state: "working", look: { hair: 0, skin: 0, suit: 0 },
  fuel: { fill: 0.4, tick: 0.75, high: false }, drones: 0, selected: false, compactedAt: null, ...extra,
})
const scene = (stations: Station[], extra: Partial<Scene> = {}): Scene => {
  const { width, height } = layout(stations.length)
  return { width, height, stations, mcp: [], frame: 3, now: 10_000, still: false, ...extra }
}
const draw = (sc: Scene) => {
  const r = recorder()
  drawShip(r.g as unknown as CanvasRenderingContext2D, sc)
  return r
}
const coloursAt = (runs: [number, number, number, number, string][], x: number, y: number) =>
  runs.filter(([rx, ry, w, h]) => x >= rx && x < rx + w && y >= ry && y < ry + h).map(r => r[4])
// The beacon sits over the middle of the station.
const beaconOf = (runs: ReturnType<typeof draw>["runs"], s: Station) => coloursAt(runs, s.x + 52 - 2, s.y + 3).at(-1)

describe("Drawing the bridge", () => {
  it("draws only inside the picture, for every state and screen", () => {
    const states = ["waiting", "stuck", "error", "working", "finished", "idle"]
    const screens = ["ask", "wait", "fail", "done", "off", "compact", "shell", "code", "read", "web", "task", "think"] as const
    const list = screens.map((screen, i) => station({ screen, state: states[i % 6], drones: i % 3, selected: i === 0, compactedAt: 9_000 }))
    const positions = layout(list.length).stations
    list.forEach((s, i) => Object.assign(s, positions[i]))
    const sc = scene(list, { mcp: ["ok", "failed", "unknown"] })
    for (const frame of [0, 1, 2, 5, 11]) {
      const { runs } = draw({ ...sc, frame })
      expect(runs.length).toBeGreaterThan(500)
      for (const [x, y, w, h] of runs) {
        expect(x).toBeGreaterThanOrEqual(-2)
        expect(y).toBeGreaterThanOrEqual(0)
        expect(x + w).toBeLessThanOrEqual(sc.width + 2)
        expect(y + h).toBeLessThanOrEqual(sc.height)
      }
    }
  })

  it("the beacon is the colour of the state, and blinks only for what needs you", () => {
    const states = ["waiting", "stuck", "error", "working", "finished", "idle"]
    const list = states.map(state => station({ state }))
    const positions = layout(list.length).stations
    list.forEach((s, i) => Object.assign(s, positions[i]))
    const lit = draw(scene(list, { frame: 0 })).runs
    expect(list.map(s => beaconOf(lit, s))).toEqual(["#ffc04d", "#ff8a3d", "#ff5a6e", "#6fc3ff", "#5ce07a", "#7a829c"])
    const dark = draw(scene(list, { frame: 3 })).runs
    expect(list.map(s => beaconOf(dark, s))).toEqual(["#0d1022", "#ff8a3d", "#0d1022", "#6fc3ff", "#5ce07a", "#7a829c"])
  })

  it("holds still when asked: every frame the same picture", () => {
    const sc = scene([station({ screen: "shell", drones: 2 })], { still: true })
    expect(draw({ ...sc, frame: 1 }).runs).toEqual(draw({ ...sc, frame: 9 }).runs)
    // And moves when not.
    const moving = { ...sc, still: false }
    expect(draw({ ...moving, frame: 1 }).runs).not.toEqual(draw({ ...moving, frame: 9 }).runs)
  })

  it("the gauge fills to the context, amber when close, with the compaction tick", () => {
    const s = station({ fuel: { fill: 0.5, tick: 0.75, high: false } })
    const full = (fuel: Station["fuel"]) => draw(scene([{ ...s, fuel }], { still: true })).runs.filter(r => r[0] >= s.x + 66 && r[0] < s.x + 72 && (r[4] === "#9be7c4" || r[4] === "#ffc04d"))
    expect(full({ fill: 0.5, tick: 0.75, high: false }).find(r => r[4] === "#9be7c4")?.[3]).toBe(12)
    expect(full({ fill: 0.9, tick: 0.75, high: true }).some(r => r[4] === "#ffc04d" && r[3] === 22)).toBe(true)
    // Not known: no fill at all.
    expect(full({ fill: null, tick: null, high: false })).toEqual([])
  })

  it("marks the station that is picked", () => {
    const r = recorder()
    drawShip(r.g as unknown as CanvasRenderingContext2D, scene([station({ selected: true }), station({ x: 108 })]))
    expect(r.g.strokes).toBe(1)
  })
})
