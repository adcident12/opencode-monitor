// Playing one session back. Pure: the server's replay in, what to show at a moment out. The
// rules are the Now tab's, so a moment of the replay looks as it would have looked live.
import { screenForTool, type Screen } from "./ship"

export type SegKind = "reading" | "thinking" | "writing" | "tool" | "compact" | "waiting"
/** [start, end, kind, detail], times in ms. */
export type Seg = [number, number, SegKind, string]

export interface ReplayRow {
  id: string
  name: string
  title: string
  sub: boolean
  segs: Seg[]
}

export interface Replay {
  session: { id: string; title: string; project: string }
  start: number
  end: number
  now: number
  stuckMs: number
  rows: ReplayRow[]
  moreSubagents: number
  turns: { at: number; end: number; ending: string }[]
  context: [number, number][]
  contextLimit: number | null
  compactAt: number | null
  compactions: number[]
  plans: [number, [string, string][]][]
}

/** A stretch where nothing at all happened, longer than this, is skipped… */
export const SILENT_MS = 2 * 60_000
/** …and shown in this much playback time instead. */
export const SKIPPED_MS = 20_000

/** The silences of a session: stretches with no row doing anything, longer than SILENT_MS. */
export function silencesOf(r: Replay): [number, number][] {
  const all = r.rows.flatMap(row => row.segs).sort((a, b) => a[0] - b[0])
  const gaps: [number, number][] = []
  let reach = r.start
  for (const [a, b] of all) {
    if (a - reach > SILENT_MS) gaps.push([reach, a])
    reach = Math.max(reach, b)
  }
  if (r.end - reach > SILENT_MS) gaps.push([reach, r.end])
  return gaps
}

/**
 * Playback time against real time. Without skipping they are the same, from the start of
 * the session; skipping, each silence takes SKIPPED_MS of playback.
 */
export function clockOf(r: Replay, skip: boolean) {
  const gaps = skip ? silencesOf(r) : []
  const cut = (g: [number, number]) => g[1] - g[0] - SKIPPED_MS
  const length = r.end - r.start - gaps.reduce((n, g) => n + cut(g), 0)
  /** ms of playback -> real time */
  const toReal = (p: number) => {
    let real = r.start + p
    for (const g of gaps) {
      if (real <= g[0]) break
      const into = real - g[0]
      if (into < SKIPPED_MS) return g[0] + (into / SKIPPED_MS) * (g[1] - g[0])
      real += cut(g)
    }
    return Math.min(real, r.end)
  }
  /** real time -> ms of playback */
  const toPlay = (t: number) => {
    let p = t - r.start
    for (const g of gaps) {
      if (t <= g[0]) break
      if (t < g[1]) return p - (t - g[0]) + ((t - g[0]) / (g[1] - g[0])) * SKIPPED_MS
      p -= cut(g)
    }
    return Math.max(0, Math.min(p, length))
  }
  return { length, gaps, toReal, toPlay }
}

// When two things happen at once, the one that matters more to you is shown.
const RANK: Record<SegKind, number> = { waiting: 5, compact: 4, tool: 3, writing: 2, thinking: 1, reading: 0 }

/** What a row was doing at a moment: the most telling of the segments open then. */
export function segAt(row: ReplayRow, t: number): Seg | null {
  let best: Seg | null = null
  for (const s of row.segs) {
    if (s[0] > t) break
    if (t < s[1] && (!best || RANK[s[2]] > RANK[best[2]])) best = s
  }
  return best
}

export type ReplayState = "waiting" | "stuck" | "error" | "working" | "finished" | "idle"

const ENDED: Record<string, ReplayState> = { done: "finished", cut: "error", error: "error", aborted: "idle", unanswered: "idle", continued: "working", open: "working" }

/** The session's state at a moment, by the Now tab's rules. */
export function stateAt(r: Replay, t: number): { state: ReplayState; seg: Seg | null } {
  const seg = r.rows[0] ? segAt(r.rows[0], t) : null
  if (seg?.[2] === "waiting") return { state: "waiting", seg }
  if (seg?.[2] === "tool" && t - seg[0] > r.stuckMs) return { state: "stuck", seg }
  if (seg) return { state: "working", seg }
  // Nothing open: between two steps of a prompt, or after it ended.
  const turn = r.turns.findLast(x => x.at <= t)
  if (!turn) return { state: "idle", seg: null }
  if (t <= turn.end) return { state: "working", seg: null }
  return { state: ENDED[turn.ending] ?? "idle", seg: null }
}

/** The tool a segment ran: the first word of its detail. */
export const toolOf = (seg: Seg | null) => (seg?.[2] === "tool" ? (seg[3].split(" ")[0] ?? "") : "")

/** What the console screen shows at that moment, as on the live bridge. */
export function screenAt(state: ReplayState, seg: Seg | null): Screen {
  const byState: Partial<Record<ReplayState, Screen>> = { waiting: "ask", stuck: "wait", error: "fail", finished: "done", idle: "off" }
  if (byState[state]) return byState[state]
  if (seg?.[2] === "compact") return "compact"
  return screenForTool(toolOf(seg))
}

/** The latest value at or before t of a list of [time, value], oldest first. */
function latest<T>(list: [number, T][], t: number): T | null {
  let found: T | null = null
  for (const [at, v] of list) {
    if (at > t) break
    found = v
  }
  return found
}

/** The figures at a moment: context, calls so far, time waited for you, compactions, the plan. */
export function figuresAt(r: Replay, t: number) {
  const main = r.rows[0]?.segs ?? []
  const compacting = main.some(s => s[2] === "compact" && s[0] <= t && t < s[1])
  return {
    /** null while compacting, and before the first request: see `compacting` for which. */
    context: compacting ? null : latest(r.context, t),
    compacting,
    toolCalls: r.rows.reduce((n, row) => n + row.segs.filter(s => s[2] === "tool" && s[0] <= t).length, 0),
    waitedMs: main.filter(s => s[2] === "waiting").reduce((n, s) => n + Math.max(0, Math.min(t, s[1]) - s[0]), 0),
    compactions: r.compactions.filter(c => c <= t).length,
    plan: latest(r.plans, t),
    /** Subagents at work at that moment. */
    busy: r.rows.slice(1).filter(row => segAt(row, t)),
  }
}

export type ReplayEvent = { at: number; kind: "prompt" | "tool" | "plan" | "waiting" | "answered" | "compact" | "ended"; text: string; row: string }

/** The agent writing its task list is a change of plan, not work with a tool. */
export const isPlanCall = (seg: Seg) => seg[2] === "tool" && toolOf(seg) === "todowrite"

/** What happened, in order, for the list beside the picture. */
export function eventsOf(r: Replay): ReplayEvent[] {
  const events: ReplayEvent[] = []
  for (const row of r.rows) events.push(...rowEvents(row, r.now))
  for (const t of r.compactions) events.push({ at: t, kind: "compact", text: "", row: "" })
  for (const turn of r.turns) {
    events.push({ at: turn.at, kind: "prompt", text: "", row: "" })
    // A prompt still going, or followed by another before it ended, has no end to tell.
    if (turn.ending !== "open" && turn.ending !== "continued") events.push({ at: turn.end, kind: "ended", text: turn.ending, row: "" })
  }
  return events.sort((a, b) => a.at - b.at)
}

/** One row's calls and waits; a subagent's are marked with its name. */
function rowEvents(row: ReplayRow, now: number): ReplayEvent[] {
  const who = row.sub ? row.name : ""
  const events: ReplayEvent[] = []
  for (const seg of row.segs) {
    const [a, b, kind, detail] = seg
    if (kind === "tool") events.push(isPlanCall(seg) ? { at: a, kind: "plan", text: "", row: who } : { at: a, kind: "tool", text: detail, row: who })
    if (kind !== "waiting") continue
    events.push({ at: a, kind: "waiting", text: detail, row: who })
    if (b < now) events.push({ at: b, kind: "answered", text: "", row: who })
  }
  return events
}
