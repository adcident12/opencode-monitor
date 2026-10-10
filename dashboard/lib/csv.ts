// Turning figures into a CSV file the browser saves. Nothing leaves the machine: the file is
// built from what the page already has.

type Cell = string | number | null | undefined

/**
 * One cell. Quoted when it holds a separator, a quote or a line break. A cell that a
 * spreadsheet would run as a formula (=, +, -, @ at the start) gets a leading apostrophe:
 * session titles are written by the agent and must not become formulas.
 */
export function cell(value: Cell): string {
  if (value == null) return ""
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : ""
  let text = value
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

/** Rows to CSV text, with a byte-order mark so spreadsheet programs read Thai correctly. */
export function toCsv(header: string[], rows: Cell[][]): string {
  return "﻿" + [header, ...rows].map(row => row.map(cell).join(",")).join("\r\n") + "\r\n"
}

/** Asks the browser to save the text as a file. */
export function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }))
  const link = document.createElement("a")
  link.href = url
  link.download = name
  document.body.appendChild(link)
  link.click()
  link.remove()
  // Revoked on the next tick: some browsers start the download after click() returns.
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

const minutes = (ms: number) => Math.round(ms / 6000) / 10

/** Per day: the figures behind the Stats charts, in minutes and plain counts. */
export function dailyCsv(days: { date: string; activeMs: number; waitMs: number; prompts: number; stuck: number; abandoned: number; toolCalls: number; toolErrors: number; compactions: number; sessions: number; tokens: number; cost: number }[]) {
  return toCsv(
    ["date", "agent_minutes", "waiting_minutes", "prompts", "hung_calls", "abandoned_calls", "tool_calls", "tool_errors", "compactions", "sessions", "tokens", "cost_usd"],
    days.map(d => [d.date, minutes(d.activeMs), minutes(d.waitMs), d.prompts, d.stuck, d.abandoned, d.toolCalls, d.toolErrors, d.compactions, d.sessions, d.tokens, d.cost]),
  )
}

/** Per session: what each one took. */
export function sessionsCsv(rows: { id: string; title: string; project: string; activeMs: number; waitMs: number; compactions: number; tokens: number; cost: number; toolCalls: number; lastAt: number }[]) {
  return toCsv(
    ["session_id", "title", "project", "agent_minutes", "waiting_minutes", "compactions", "tokens", "cost_usd", "tool_calls", "last_activity"],
    rows.map(r => [r.id, r.title, r.project, minutes(r.activeMs), minutes(r.waitMs), r.compactions, r.tokens, r.cost, r.toolCalls, new Date(r.lastAt).toISOString()]),
  )
}
