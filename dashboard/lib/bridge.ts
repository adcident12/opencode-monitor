// The whole bridge played back: every session of one day at the same moment. Pure. Each
// session is its own replay, read by the same rules as when it is played alone, so a
// station here and that session's own replay never disagree.
import { eventsOf, segAt, stateAt, type Replay, type ReplayRow, type ReplayState, type Seg } from "./replay"

export interface Bridge {
  /** 2026-10-09: a day of the machine the monitor runs on. */
  day: string
  start: number
  end: number
  now: number
  /** In the order they began, so each keeps its station through the day. */
  sessions: Replay[]
  /** Sessions of that day left off the bridge, for want of room. */
  more: number
}

/** What happened within the day, cut at its two ends. */
function within(segs: Seg[], start: number, end: number): Seg[] {
  const out: Seg[] = []
  for (const s of segs) if (s[1] > start && s[0] < end) out.push([Math.max(s[0], start), Math.min(s[1], end), s[2], s[3]])
  return out
}

/** What the day's clock is made from: every row of every session, so a silence is one of them all. */
export function playedOf(bridge: Bridge): Pick<Replay, "start" | "end" | "rows"> {
  const rows = bridge.sessions.flatMap(r => r.rows.map(row => ({ ...row, segs: within(row.segs, bridge.start, bridge.end) })))
  return { start: bridge.start, end: bridge.end, rows }
}

/** The name on a session's station: its folder, or its title when another session of the day shares the folder. */
export function tagOf(replay: Replay, all: Replay[]): string {
  const folder = (r: Replay) => r.session.project || r.session.title || r.session.id
  const shared = all.some(other => other.session.id !== replay.session.id && folder(other) === folder(replay))
  return shared ? replay.session.title || folder(replay) : folder(replay)
}

/** One row a session for the timeline: what its own agent did that day, under the name on its station. */
export function rowsOf(bridge: Bridge): (ReplayRow & { caption: string })[] {
  return bridge.sessions.map(r => ({
    id: r.session.id,
    name: tagOf(r, bridge.sessions),
    title: r.session.title,
    sub: false,
    caption: r.session.project,
    segs: within(r.rows[0]?.segs ?? [], bridge.start, bridge.end),
  }))
}

/** The latest value at or before t of a list of [time, value], oldest first. */
function latest<T>(list: [number, T][], t: number): T | null {
  let lo = 0
  let hi = list.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (list[mid][0] <= t) lo = mid + 1
    else hi = mid
  }
  return lo ? list[lo - 1][1] : null
}

export interface CrewMember {
  replay: Replay
  /** Its state by the Now tab's rules; idle before it began. */
  state: ReplayState
  seg: Seg | null
  /** Had it begun by then? */
  begun: boolean
  /** The size of its context then; null while compacting and before its first request. */
  context: number | null
  /** Its subagents at work then: the one whose doings are told, and how many there are. */
  sub: ReplayRow | null
  busy: number
  /** Its last compaction up to then, for the puff over its gauge. */
  compactedAt: number | null
}

/** Every session of the day at one moment. */
export function crewAt(bridge: Bridge, t: number): CrewMember[] {
  return bridge.sessions.map(replay => {
    const { state, seg } = stateAt(replay, t)
    const subs = replay.rows.slice(1).filter(row => segAt(row, t))
    return {
      replay,
      state,
      seg,
      begun: t >= replay.start,
      context: seg?.[2] === "compact" ? null : latest(replay.context, t),
      sub: subs[0] ?? null,
      busy: subs.length,
      compactedAt: replay.compactions.findLast(c => c <= t) ?? null,
    }
  })
}

export const TALLY_ORDER = ["waiting", "stuck", "error", "working", "finished", "idle"] as const

/** How many sessions were in each state. */
export function tallyOf(crew: CrewMember[]): Record<ReplayState, number> {
  const tally: Record<ReplayState, number> = { waiting: 0, stuck: 0, error: 0, working: 0, finished: 0, idle: 0 }
  for (const member of crew) tally[member.state]++
  return tally
}

const TURNING = new Set(["prompt", "waiting", "answered", "compact", "ended"])

/**
 * The moments worth stepping between on a whole bridge: a prompt, a wait and its answer, a
 * compaction, the end of a turn. Not every tool call: with a dozen sessions those are too
 * many to step through, and each session's own replay has them.
 */
export function momentsOf(bridge: Bridge): { at: number; session: string; kind: string }[] {
  return bridge.sessions
    .flatMap(r => eventsOf(r).filter(e => TURNING.has(e.kind) && !e.row && e.at >= bridge.start && e.at <= bridge.end).map(e => ({ at: e.at, session: r.session.id, kind: e.kind })))
    .sort((a, b) => a.at - b.at)
}
