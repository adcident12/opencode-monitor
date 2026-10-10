import { describe, expect, it } from "vitest"
import type { Replay, Seg } from "./replay"
import { drawScene, fitText, toolsOf, type SceneInput } from "./replay-scene"

// A context that keeps what was drawn: dots and labels, with their colours.
function recorder() {
  const drawn = { dots: [] as { x: number; y: number; r: number; colour: string }[], labels: [] as { text: string; colour: string }[], lines: 0, dashed: 0 }
  let pending: { x: number; y: number; r: number } | null = null
  const g = {
    fillStyle: "", strokeStyle: "", lineWidth: 1, lineCap: "butt", globalAlpha: 1, font: "", textAlign: "left", textBaseline: "alphabetic",
    clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() { drawn.lines++ },
    setLineDash(d: number[]) { if (d.length) drawn.dashed++ },
    arc(x: number, y: number, r: number) { pending = { x, y, r } },
    fill() { if (pending) drawn.dots.push({ ...pending, colour: String(this.fillStyle) }) },
    measureText: (text: string) => ({ width: text.length * 7 }),
    fillText(text: string) { drawn.labels.push({ text, colour: String(this.fillStyle) }) },
  }
  return { g: g as unknown as CanvasRenderingContext2D, drawn }
}

const colours = { fg: "fg", muted: "muted", line: "line", working: "working", waiting: "waiting", stuck: "stuck", error: "error", finished: "finished" }
const input = (extra: Partial<SceneInput> = {}): SceneInput => ({
  width: 600, height: 256, font: "sans", colours, tools: ["bash", "read", "context7_query-docs"],
  state: "working", seg: null, busy: [], now: 10, phase: 0, agentName: "build", youLabel: "You", ...extra,
})
const tool = (name: string): Seg => [0, 100, "tool", `${name} something`]

describe("The agent and its tools", () => {
  it("places the tools used most, and leaves a change of plan out", () => {
    const replay = { rows: [{ id: "r", name: "build", title: "", sub: false, segs: [tool("read"), tool("bash"), tool("bash"), tool("todowrite"), tool("todowrite"), tool("todowrite")] }] } as unknown as Replay
    expect(toolsOf(replay)).toEqual(["bash", "read"])
  })

  it("cuts a name short to the room it has", () => {
    const width = (s: string) => s.length * 7
    expect(fitText("context7_query-docs", 1000, width)).toBe("context7_query-docs")
    const cut = fitText("context7_query-docs", 70, width)
    expect(cut.endsWith("…")).toBe(true)
    expect(width(cut)).toBeLessThanOrEqual(70)
  })

  it("draws the agent in the colour of its state, with its name, and every tool", () => {
    const { g, drawn } = recorder()
    drawScene(g, input({ state: "stuck" }))
    expect(drawn.labels.map(l => l.text)).toEqual(expect.arrayContaining(["bash", "read", "You", "build"]))
    // The agent's dot is the biggest one drawn, in the colour of being stuck.
    const agent = drawn.dots.reduce((a, b) => (b.r > a.r ? b : a))
    expect(agent.colour).toBe("stuck")
    expect(drawn.dashed).toBe(0)
  })

  it("draws a line to the tool in use, or to you while it waits", () => {
    const working = recorder()
    drawScene(working.g, input({ seg: tool("bash") }))
    expect(working.drawn.dashed).toBe(1)
    expect(working.drawn.dots.some(d => d.colour === "working" && d.r === 3.5)).toBe(true)

    const waiting = recorder()
    drawScene(waiting.g, input({ state: "waiting", seg: [0, 1, "waiting", "bash npm test"] }))
    expect(waiting.drawn.dashed).toBe(1)
    expect(waiting.drawn.labels.find(l => l.text === "You")?.colour).toBe("fg")
    expect(waiting.drawn.dots.some(d => d.colour === "waiting" && d.r === 3.5)).toBe(true)
  })

  it("gives the tools without a place of their own one to share, and names the one in use", () => {
    const idle = recorder()
    drawScene(idle.g, input({ tools: ["bash"], others: "3 other tools" }))
    expect(idle.drawn.labels.find(l => l.text === "3 other tools")?.colour).toBe("muted")
    expect(idle.drawn.dashed).toBe(0)

    const reaching = recorder()
    drawScene(reaching.g, input({ tools: ["bash"], others: "3 other tools", seg: tool("webfetch") }))
    expect(reaching.drawn.dashed).toBe(1)
    expect(reaching.drawn.labels.find(l => l.text === "webfetch")?.colour).toBe("fg")
    expect(reaching.drawn.labels.some(l => l.text === "3 other tools")).toBe(false)

    // Writing the task list is a change of plan: it reaches for no tool.
    const planning = recorder()
    drawScene(planning.g, input({ tools: ["bash"], others: "3 other tools", seg: tool("todowrite") }))
    expect(planning.drawn.dashed).toBe(0)
  })

  it("leaves the line of a call just made to fade, and never over the one in use", () => {
    const after = recorder()
    drawScene(after.g, input({ glow: new Map([["read", 0.5]]) }))
    expect(after.drawn.dashed).toBe(1)

    const during = recorder()
    drawScene(during.g, input({ seg: tool("read"), glow: new Map([["read", 0.5]]) }))
    expect(during.drawn.dashed).toBe(1)
  })

  it("keeps every subagent at work inside the picture, left of the tools", () => {
    const { g, drawn } = recorder()
    const busy = Array.from({ length: 7 }, (_, i) => ({ id: `k${i}`, name: "explore", title: "", sub: true, segs: [[0, 100, "thinking", ""] as Seg] }))
    drawScene(g, input({ width: 358, busy }))
    // Each subagent is a ring with a dot of radius 11 * 0.36.
    const subs = drawn.dots.filter(d => Math.abs(d.r - 11 * 0.36) < 0.01)
    expect(subs).toHaveLength(7)
    expect(Math.max(...subs.map(d => d.x))).toBeLessThan(358 * 0.62 - 20)
    expect(Math.min(...subs.map(d => d.x))).toBeGreaterThanOrEqual(24)
  })

  it("draws each subagent at work, with its own line to its tool", () => {
    const { g, drawn } = recorder()
    const busy = [{ id: "k", name: "explore", title: "", sub: true, segs: [[0, 100, "tool", "read a.ts"] as Seg] }]
    drawScene(g, input({ busy, seg: tool("bash") }))
    expect(drawn.dashed).toBe(2)
  })
})
