// Keeps a record of every state change so you can look back: when did it start waiting,
// how long did it sit there, what was it running when it got stuck.
// This is the monitor's own file. Only already-redacted snapshot data is written to it.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { compareText } from './text.mjs';

// Everything within retention is kept in memory, so any page can be served without reading
// the file again. The cap only guards against a runaway; if it is ever hit, pages say so.
const MAX_IN_MEMORY = 50_000;
const DAY_MS = 86_400_000;
const PAGE_MAX = 500;
// States that needed you; a change into or out of one is "what needed you".
const NEEDS_YOU = new Set(['waiting', 'stuck', 'error']);

/** Newest first. Two sessions can change state in the same tick, so the id breaks ties. */
const newestFirst = (a, b) => b.t - a.t || compareText(b.id, a.id);

/**
 * A position in the history: "<time>:<session id>". Pages are cut at a position, not at a
 * page number, because new entries keep arriving at the top while you read.
 * @returns {{t: number, id: string}|null}
 */
export function parseCursor(text) {
  const m = /^(\d{1,15}):([A-Za-z0-9_-]{1,80})$/.exec(String(text ?? ''));
  return m ? { t: Number(m[1]), id: m[2] } : null;
}
export const cursorOf = e => `${e.t}:${e.id}`;
const olderThan = (e, c) => e.t < c.t || (e.t === c.t && e.id < c.id);
const newerThan = (e, c) => e.t > c.t || (e.t === c.t && e.id > c.id);

function toEvent(session, previous, now) {
  return {
    t: now,
    since: session.since,
    id: session.id,
    title: session.title,
    project: session.project,
    from: previous?.to ?? null,
    fromMs: previous ? now - previous.t : null,
    to: session.state,
    reason: session.reason,
    permission: session.prompt?.permission ?? null,
    limitMs: session.limitMs ?? null,
    error: session.detail ?? null,
    detail: session.prompt?.detail || session.current?.summary || null,
  };
}

/**
 * The entries of the file that are within retention, oldest first. What is past it, and any
 * broken line, is dropped from the file itself.
 */
function readKept(file, cutoff) {
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const events = [];
  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      if (event.t >= cutoff && event.id && event.to) events.push(event);
    } catch {
      // A half-written line from a crash; skip it.
    }
  }
  if (events.length !== lines.length) writeFileSync(file, events.map(e => JSON.stringify(e)).join('\n') + (events.length ? '\n' : ''));
  return events;
}

/**
 * @param {object} options
 * @param {string|null} options.file  JSON Lines file; null keeps history in memory only
 * @param {number} options.retentionDays
 * @param {boolean} [options.enabled]
 */
export function createHistory({ file, retentionDays, enabled = true, now = Date.now() }) {
  let events = enabled && file && existsSync(file) ? readKept(file, now - retentionDays * DAY_MS) : [];
  let dropped = 0; // entries still in the file that memory no longer holds
  const last = new Map(events.map(event => [event.id, event])); // session id -> its latest event
  // The cap only guards against a runaway; what goes past it stays in the file.
  const capToMemory = () => {
    if (events.length <= MAX_IN_MEMORY) return;
    dropped += events.length - MAX_IN_MEMORY;
    events = events.slice(-MAX_IN_MEMORY);
  };
  capToMemory();

  function record(sessions, at) {
    if (!enabled) return;
    const ids = new Set(sessions.map(s => s.id));
    const added = [];
    for (const session of sessions) {
      // Subagents are covered by their parent's entry.
      if (session.parentId && ids.has(session.parentId)) continue;
      const previous = last.get(session.id);
      if (previous?.to === session.state) continue;
      const event = toEvent(session, previous, at);
      last.set(session.id, event);
      added.push(event);
    }
    if (!added.length) return;
    events.push(...added);
    // A monitor left running for weeks drops what passes retention, as a restart would.
    const cutoff = at - retentionDays * DAY_MS;
    if (events[0]?.t < cutoff) events = events.filter(e => e.t >= cutoff);
    capToMemory();
    if (file) {
      try {
        mkdirSync(dirname(file), { recursive: true });
        appendFileSync(file, added.map(e => JSON.stringify(e)).join('\n') + '\n');
      } catch (err) {
        console.warn(`Could not write history to ${file}: ${err.code ?? err.message}`);
      }
    }
  }

  return {
    record,
    get count() {
      return events.length;
    },
    /** Newest first; with a session id, only that session's changes. */
    list: ({ limit = 300, session = null } = {}) => (session ? events.filter(e => e.id === session) : events).slice(-limit).reverse(),
    /**
     * One page, newest first.
     * @param {object} q
     * @param {string|null} [q.before]  cursor: only entries older than it (the next page down)
     * @param {string|null} [q.after]   cursor: only entries newer than it (what arrived since)
     * @param {number} [q.limit]
     * @param {string|null} [q.session] only this session
     * @param {boolean} [q.attention]   only changes into or out of a state that needed you
     * @returns {{events: object[], more: number, truncated: boolean}} more: matching entries
     *   older than this page
     */
    page: ({ before = null, after = null, limit = 100, session = null, attention = false } = {}) => {
      const size = Math.min(PAGE_MAX, Math.max(1, Math.floor(Number(limit)) || 100));
      const from = parseCursor(before);
      const since = parseCursor(after);
      const matching = events
        .filter(e => (!session || e.id === session) && (!attention || NEEDS_YOU.has(e.to) || (e.from != null && NEEDS_YOU.has(e.from))))
        .filter(e => (!from || olderThan(e, from)) && (!since || newerThan(e, since)))
        .sort(newestFirst);
      return { events: matching.slice(0, size), more: Math.max(0, matching.length - size), truncated: dropped > 0 };
    },
    /** Every session that has an entry, most recently changed first. */
    sessions: () => {
      const seen = new Map();
      for (const e of events) seen.set(e.id, { id: e.id, title: e.title, project: e.project, lastAt: e.t, count: (seen.get(e.id)?.count ?? 0) + 1 });
      return [...seen.values()].sort((a, b) => b.lastAt - a.lastAt);
    },
  };
}
