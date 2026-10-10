// Draws the agent and the tools it reaches for, at one moment of a replay: a line runs to
// the tool in use, subagents appear while they work, and while it waits for you the line
// runs to you. Colours come from the page's theme, so it reads in light and dark alike.
import { isPlanCall, segAt, toolOf, type Replay, type ReplayRow, type ReplayState, type Seg } from "./replay"

type Point = [number, number]

export interface SceneColours {
  fg: string
  muted: string
  line: string
  working: string
  waiting: string
  stuck: string
  error: string
  finished: string
}

export interface SceneInput {
  width: number
  height: number
  font: string
  colours: SceneColours
  /** The tools shown on the right, most used first. */
  tools: string[]
  /** The name of one more place, for every tool that has none of its own; null when all have one. */
  others?: string | null
  state: ReplayState
  seg: Seg | null
  busy: ReplayRow[]
  now: number
  /** Where the dot is on its line, from 0 at the agent to 1 at the tool. */
  phase: number
  /**
   * Tools reached for a moment ago, each with how much of its line is left to see, from 1
   * down to 0. Played fast, a call of a second is on screen for a blink: its line stays a
   * little longer and fades, so that it can be seen at all.
   */
  glow?: Map<string, number>
  agentName: string
  youLabel: string
}

/** The tools a session used most, for fixed places on the right; a change of plan is not one. */
export function toolsOf(replay: Replay, max = 6): string[] {
  const count = new Map<string, number>()
  for (const row of replay.rows) {
    for (const s of row.segs) if (s[2] === "tool" && !isPlanCall(s)) count.set(toolOf(s), (count.get(toolOf(s)) ?? 0) + 1)
  }
  return [...count].sort((a, b) => b[1] - a[1]).slice(0, max).map(([name]) => name)
}

/** The tool a segment reaches for; none for a change of plan, which is not work with a tool. */
export const toolInUse = (seg: Seg | null) => (seg?.[2] === "tool" && !isPlanCall(seg) ? toolOf(seg) : "")

/** Text cut short with "…" until it fits the room it has. */
export function fitText(text: string, room: number, width: (s: string) => number): string {
  let shown = text
  while (shown.length > 1 && width(shown) > room) shown = `${shown.slice(0, -2)}…`
  return shown
}

export function drawScene(g: CanvasRenderingContext2D, s: SceneInput) {
  const { width: w, height: h, colours: c, tools } = s
  const phase = s.phase
  g.clearRect(0, 0, w, h)

  const label = (text: string, x: number, y: number, colour: string, align: CanvasTextAlign = "left", room = Infinity) => {
    g.fillStyle = colour
    g.font = `400 12px ${s.font}`
    g.textAlign = align
    g.textBaseline = "middle"
    g.fillText(fitText(text, room, t => g.measureText(t).width), x, y)
  }
  const link = (a: Point, b: Point, colour: string, strength = 1) => {
    g.strokeStyle = colour
    g.globalAlpha = 0.45 * strength
    g.lineWidth = 1.5
    g.setLineDash([4, 5])
    g.beginPath()
    g.moveTo(...a)
    g.lineTo(...b)
    g.stroke()
    g.setLineDash([])
    g.globalAlpha = strength
    dot(a[0] + (b[0] - a[0]) * phase, a[1] + (b[1] - a[1]) * phase, 3.5, colour)
    g.globalAlpha = 1
  }
  const dot = (x: number, y: number, r: number, colour: string) => {
    g.fillStyle = colour
    g.beginPath()
    g.arc(x, y, r, 0, Math.PI * 2)
    g.fill()
  }
  // The agent is drawn as the mark of the monitor: an open ring with a dot of its state.
  const ring = (x: number, y: number, r: number, colour: string) => {
    g.strokeStyle = c.fg
    g.lineWidth = r / 7
    g.lineCap = "round"
    g.beginPath()
    g.arc(x, y, r, -Math.PI / 2 + 0.55, -Math.PI / 2 + 0.55 + Math.PI * 1.7)
    g.stroke()
    dot(x, y, r * 0.36, colour)
  }

  const agent: Point = [w * 0.3, h * 0.5]
  const you: Point = [agent[0], 26]
  const places = s.others ? [...tools, s.others] : tools
  const spot = (i: number): Point => [w * 0.62, 28 + i * ((h - 56) / Math.max(1, places.length - 1))]
  // Where a call reaches: its tool's own place, else the one for the others; a change of plan reaches nowhere.
  const placeOf = (name: string) => {
    if (!name) return -1
    const own = tools.indexOf(name)
    return own < 0 && s.others ? tools.length : own
  }
  const toolSpot = (seg: Seg | null) => placeOf(toolInUse(seg))
  const index = toolSpot(s.seg)
  const inUse = new Map<number, string>()
  for (const row of s.busy) {
    const seg = segAt(row, s.now)
    if (toolSpot(seg) >= 0) inUse.set(toolSpot(seg), toolOf(seg))
  }
  if (index >= 0) inUse.set(index, toolOf(s.seg))

  places.forEach((name, i) => {
    const [x, y] = spot(i)
    g.strokeStyle = c.line
    g.lineWidth = 1.5
    g.beginPath()
    g.arc(x, y, 6, 0, Math.PI * 2)
    g.stroke()
    // The tool in use stands out; in the place for the others, it is named.
    label(inUse.get(i) ?? name, x + 13, y, inUse.has(i) ? c.fg : c.muted, "left", w - x - 21)
  })
  const waiting = s.state === "waiting"
  dot(you[0], you[1], 6, waiting ? c.waiting : c.line)
  label(s.youLabel, you[0] + 13, you[1], waiting ? c.fg : c.muted)

  // Subagents share the room under the agent, however many are at work.
  const first = Math.max(24, agent[0] - 70)
  const gap = s.busy.length > 1 ? Math.min(70, (w * 0.62 - 40 - first) / (s.busy.length - 1)) : 0
  s.busy.forEach((row, i) => {
    const at: Point = [first + i * gap, h - 30]
    g.strokeStyle = c.line
    g.beginPath()
    g.moveTo(...agent)
    g.lineTo(...at)
    g.stroke()
    ring(at[0], at[1], 11, c.working)
    const to = toolSpot(segAt(row, s.now))
    if (to >= 0) link(at, spot(to), c.working)
  })
  // The lines of a moment ago, fading; never over one in use now.
  for (const [name, strength] of s.glow ?? []) {
    const place = placeOf(name)
    if (place >= 0 && !inUse.has(place)) link(agent, spot(place), c.working, strength)
  }
  if (waiting) link(agent, you, c.waiting)
  else if (index >= 0) link(agent, spot(index), c.working)
  // At work with no tool in hand (reading, thinking, writing): a ring spreads from the agent.
  else if (s.state === "working") {
    g.strokeStyle = c.working
    g.globalAlpha = 0.5 * (1 - phase)
    g.lineWidth = 1.5
    g.beginPath()
    g.arc(agent[0], agent[1], 31 + phase * 12, 0, Math.PI * 2)
    g.stroke()
    g.globalAlpha = 1
  }
  const stateColour: Record<ReplayState, string> = { waiting: c.waiting, stuck: c.stuck, error: c.error, finished: c.finished, idle: c.muted, working: c.working }
  ring(agent[0], agent[1], 26, stateColour[s.state])
  label(s.agentName, agent[0], agent[1] + 42, c.fg, "center")
}
