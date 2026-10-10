// Keeps a record of every state change so you can look back: when did it start waiting,
// how long did it sit there, what was it running when it got stuck.
// This is the monitor's own file. Only already-redacted snapshot data is written to it.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const MAX_IN_MEMORY = 5000;

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
 * @param {object} options
 * @param {string|null} options.file  JSON Lines file; null keeps history in memory only
 * @param {number} options.retentionDays
 * @param {boolean} [options.enabled]
 */
export function createHistory({ file, retentionDays, enabled = true, now = Date.now() }) {
  let events = [];
  const last = new Map(); // session id -> its latest event

  if (enabled && file && existsSync(file)) {
    const cutoff = now - retentionDays * 86_400_000;
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        if (event.t >= cutoff && event.id && event.to) events.push(event);
      } catch {
        // A half-written line from a crash; skip it.
      }
    }
    // Drop what is past retention (and any broken lines) from the file itself.
    if (events.length !== lines.length) writeFileSync(file, events.map(e => JSON.stringify(e)).join('\n') + (events.length ? '\n' : ''));
    for (const event of events) last.set(event.id, event);
    events = events.slice(-MAX_IN_MEMORY);
  }

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
    if (events.length > MAX_IN_MEMORY) events = events.slice(-MAX_IN_MEMORY);
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
    /** Every session that has an entry, most recently changed first. */
    sessions: () => {
      const seen = new Map();
      for (const e of events) seen.set(e.id, { id: e.id, title: e.title, project: e.project, lastAt: e.t, count: (seen.get(e.id)?.count ?? 0) + 1 });
      return [...seen.values()].sort((a, b) => b.lastAt - a.lastAt);
    },
  };
}
