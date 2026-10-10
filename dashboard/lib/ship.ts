// The bridge view of the Now tab: one crew member per session. Everything here is a pure
// reading of a snapshot, so what the picture shows can be tested without drawing it.
import { groupByUrgency } from "./format"
import type { Session } from "./types"

export const STATION_W = 104
export const STATION_H = 64
/** The viewport band along the top, with the stars and the panel of MCP lights. */
export const HULL_TOP = 50
/** Three stations to a row; two on a phone, where three would make each one too small to read. */
export const COLUMNS = 3
export const NARROW_COLUMNS = 2
/** Below this width, in CSS pixels, the bridge has two columns. */
export const NARROW_BELOW = 560
/** The width the bridge is drawn at, before it is scaled to fit. */
export const shipWidth = (columns: number) => columns * STATION_W + 8
/** More than this and the rest are named under the picture, not squeezed in. */
export const MAX_STATIONS = 12

/** What a console screen shows. */
export type Screen = "ask" | "wait" | "fail" | "done" | "off" | "compact" | "shell" | "code" | "read" | "web" | "task" | "think"

/** The sessions on the bridge, most urgent first, and how many are left off. */
export function crewOf(sessions: Session[]) {
  const { attention, working, rest } = groupByUrgency(sessions)
  const all = [...attention, ...working, ...rest]
  return { crew: all.slice(0, MAX_STATIONS), more: Math.max(0, all.length - MAX_STATIONS) }
}

/** Where each station sits, in bridge pixels, and how tall the bridge is for that many. */
export function layout(count: number, columns = COLUMNS) {
  const width = shipWidth(columns)
  const rows = Math.max(1, Math.ceil(count / columns))
  const left = Math.round((width - columns * STATION_W) / 2)
  const stations = Array.from({ length: count }, (_, i) => ({
    x: left + (i % columns) * STATION_W,
    y: HULL_TOP + Math.floor(i / columns) * STATION_H,
  }))
  return { stations, width, height: HULL_TOP + rows * STATION_H + 8 }
}

const SHELL = new Set(["bash", "shell", "pwsh", "powershell"])
const CODE = new Set(["edit", "write", "patch", "multiedit", "apply_patch"])
const READ = new Set(["read", "grep", "glob", "list", "ls"])
const WEB = new Set(["webfetch", "websearch", "fetch"])

/** The screen for a session: its state first, then, while it works, the tool it is running. */
export function screenOf(s: Session): Screen {
  if (s.state === "waiting") return "ask"
  if (s.state === "stuck") return "wait"
  if (s.state === "error") return "fail"
  if (s.state === "finished") return "done"
  if (s.state === "idle") return "off"
  if (s.health.compacting || s.reason === "compacting") return "compact"
  const tool = s.current?.tool?.toLowerCase() ?? ""
  if (!tool) return "think"
  if (SHELL.has(tool)) return "shell"
  if (CODE.has(tool)) return "code"
  if (READ.has(tool)) return "read"
  if (tool === "task") return "task"
  // An MCP tool is named <server>_<tool>: it reaches outside, like the web.
  if (WEB.has(tool) || tool.includes("_")) return "web"
  return "think"
}

/**
 * The fuel gauge beside a station is the context: how full it is, where OpenCode compacts
 * (the tick), and whether that is close. null fill when the size is not known.
 */
export function fuelOf(s: Session) {
  const { contextTokens, contextLimit, compaction, compacting, hints } = s.health
  const known = !compacting && contextTokens != null && contextLimit != null && contextLimit > 0
  return {
    fill: known ? Math.min(1, contextTokens / contextLimit) : null,
    tick: compaction && contextLimit ? Math.min(1, compaction.at / contextLimit) : null,
    high: hints.includes("context_high"),
  }
}

/** The few words over a station's head: always the state, never anything from the session. */
export function bubbleOf(s: Session, now: number, t: (key: string, vars?: Record<string, string | number>) => string, minutes: (ms: number) => string) {
  if (s.state === "waiting") return t(s.prompt?.kind === "question" ? "ship.bubble.question" : "ship.bubble.waiting")
  if (s.state === "stuck") return t("ship.bubble.stuck", { t: minutes(now - s.since) })
  if (s.state === "error") return t("ship.bubble.error")
  if (s.state === "finished") return t("ship.bubble.finished")
  return null
}

/** The same person at the same station every time: a look picked from the session id. */
export function lookOf(id: string) {
  let h = 2166136261
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ (id.codePointAt(i) ?? 0), 16777619)
  const n = h >>> 0
  return { hair: n % 6, skin: (n >>> 3) % 6, suit: (n >>> 6) % 6 }
}

/** Subagents are drones beside the station: the ones still at it, two drawn at most. */
export function dronesOf(sessions: Session[], id: string) {
  const busy = sessions.filter(s => s.parentId === id && (s.state === "working" || s.state === "waiting" || s.state === "stuck"))
  return { shown: busy.slice(0, 2), more: Math.max(0, busy.length - 2) }
}
