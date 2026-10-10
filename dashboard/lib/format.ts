import type { Session, State } from "./types"

/** Order sessions are listed in, most urgent first. */
export const RANK: Record<State, number> = { waiting: 0, stuck: 1, error: 2, working: 3, finished: 4, idle: 5 }
export const NEEDS_YOU: ReadonlySet<State> = new Set(["waiting", "stuck", "error"])

/** 8:10:42 for the big timers; minutes and seconds always two digits after the first unit. */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = String(s % 60).padStart(2, "0")
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`
}

/** 45s, 12m 05s, 3h 20m, 2d 4h — for small inline durations. */
export function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

/** 320 ms, 1.4s, 2m 05s — for how long one tool call takes. */
export function quick(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`
  return ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : duration(ms)
}

/** Coarse: 10m, 2h 5m — for thresholds and ages where seconds are noise. */
export function rough(ms: number): string {
  return ms < 3_600_000 ? `${Math.round(ms / 60_000)}m` : duration(ms)
}

export function kilo(n: number): string {
  return `${Math.round(n / 1000)}k`
}

/** 840, 32.4k, 1.2M, 40.5M — token counts, where three digits are all anyone reads. */
export function compact(n: number): string {
  if (n < 1000) return String(Math.round(n))
  const [value, unit] = n < 999_950 ? [n / 1000, "k"] : [n / 1_000_000, "M"]
  return `${value < 100 ? value.toFixed(1) : Math.round(value)}${unit}`
}

/** Top-level sessions (subagents are shown inside their parent), most urgent first. */
export function topLevel(sessions: Session[]): Session[] {
  const ids = new Set(sessions.map(s => s.id))
  return sessions
    .filter(s => !s.parentId || !ids.has(s.parentId))
    .sort((a, b) => RANK[a.state] - RANK[b.state] || b.updatedAt - a.updatedAt)
}

export function groupByUrgency(sessions: Session[]) {
  const top = topLevel(sessions)
  return {
    attention: top.filter(s => NEEDS_YOU.has(s.state)),
    working: top.filter(s => s.state === "working"),
    rest: top.filter(s => s.state === "finished" || s.state === "idle"),
  }
}

export function childrenOf(sessions: Session[], id: string): Session[] {
  return sessions.filter(s => s.parentId === id)
}
