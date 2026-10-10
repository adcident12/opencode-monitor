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
  state: "working", seg: null, busy: [], now: 10, frame: 0, agentName: "build", youLabel: "You", ...extra,
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

  it("draws each subagent at work, with its own line to its tool", () => {
    const { g, drawn } = recorder()
    const busy = [{ id: "k", name: "explore", title: "", sub: true, segs: [[0, 100, "tool", "read a.ts"] as Seg] }]
    drawScene(g, input({ busy, seg: tool("bash") }))
    expect(drawn.dashed).toBe(2)
  })
})
