// What you set the agent to do, and how far each got: every top-level session of a period,
// by project, with how it ended and the plan it was working through. For the question "what
// did I ask for, and where is each of it now?" when there are too many sessions to remember.
//
// The plan is the agent's own todo list: OpenCode 1.x keeps it in its `todo` table, OpenCode 2
// only in each `todowrite` call, the latest of which is the plan as it stands. Your prompts are
// not read: the session's title (OpenCode's summary of the first one) says what it was for.

export const TASK_DAYS = [7, 14, 30];
const MAX_SESSIONS = 200;
const MAX_ITEMS = 30;

/** The plan a todowrite call left, as [{ content, status }]; null when its list cannot be read. */
export function planFromWrite(todos) {
  try {
    const list = JSON.parse(todos ?? 'null');
    if (!Array.isArray(list)) return null;
    return list.filter(t => t && typeof t.content === 'string').map(t => ({ content: t.content, status: typeof t.status === 'string' ? t.status : 'pending' }));
  } catch {
    return null;
  }
}

/** The latest plan among a session's tool calls (OpenCode 2 keeps it nowhere else), or []. */
export function latestPlanOf(parts) {
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    if (p.type === 'tool' && p.tool === 'todowrite' && p.status === 'completed' && p.todos) {
      const plan = planFromWrite(p.todos);
      if (plan) return plan;
    }
  }
  return [];
}

// States of the Now tab that say more than the last messages can: a prompt open, a call hung.
const LIVE = new Set(['working', 'waiting', 'stuck', 'error']);

/**
 * How a session's last turn ended, from its last messages (oldest first):
 *   working      a reply is still being written
 *   waiting      the Now tab: it waits for your answer
 *   stuck        the Now tab: it probably hangs
 *   interrupted  stopped by you, or by OpenCode putting the project away
 *   error        stopped on an error
 *   stopped      the agent finished its turn and handed back to you
 */
export function endOf(messages, now, live = null) {
  if (LIVE.has(live)) return live;
  const last = messages.findLast(m => m.role === 'assistant');
  if (!last) return 'stopped';
  const error = last.error ?? last.error_name ?? null;
  if (error === 'MessageAbortedError') return 'interrupted';
  if (error) return 'error';
  // Not completed and touched lately: still going. Long untouched: it was left so.
  if (last.completed == null) return now - last.time_created < 10 * 60_000 ? 'working' : 'interrupted';
  return 'stopped';
}

/**
 * @param {object} deps
 * @param {object[]} deps.sessions      sessions updated in the period (both versions)
 * @param {(id: string) => object[]} deps.tablePlan     1.x todo rows of a session
 * @param {Map<string, string>} deps.writes  session id -> todos JSON of its latest todowrite
 * @param {(id: string) => object[]} deps.lastMessages  its last messages, oldest first
 * @param {(id: string) => string|null} [deps.liveState]  the Now tab's state, when it shows it
 * @param {(text: string, max?: number) => string} deps.show  redaction and clipping
 */
export function tasksOf({ sessions, tablePlan, writes, lastMessages, liveState = () => null, show, now, days }) {
  const from = now - days * 86_400_000;
  const top = sessions
    .filter(s => !s.parent_id && (s.time_updated ?? s.time_created) >= from)
    .sort((a, b) => b.time_updated - a.time_updated)
    .slice(0, MAX_SESSIONS);

  const byProject = new Map();
  for (const s of top) {
    const table = tablePlan(s.id);
    const plan = table.length ? table : (planFromWrite(writes.get(s.id)) ?? []);
    const counted = plan.filter(t => t.status !== 'cancelled');
    const done = counted.filter(t => t.status === 'completed').length;
    const ended = endOf(lastMessages(s.id), now, liveState(s.id));
    const left = counted.filter(t => t.status !== 'completed');
    const open = left.length > 0 || ['error', 'interrupted', 'waiting', 'stuck'].includes(ended);
    const directory = s.directory ?? '';
    const project = show(directory.split(/[\\/]/).findLast(Boolean) ?? '', 80);
    const entry = byProject.get(directory) ?? { project, directory: show(directory, 200), lastAt: 0, open: 0, sessions: [] };
    entry.sessions.push({
      id: s.id,
      title: show(s.title ?? '', 160),
      createdAt: s.time_created,
      lastAt: s.time_updated,
      ended,
      open,
      plan: counted.length ? { done, total: counted.length } : null,
      // What is still to do, in the plan's order: the one in progress first among equals.
      left: left.slice(0, MAX_ITEMS).map(t => ({ content: show(t.content, 200), status: t.status })),
      more: Math.max(0, left.length - MAX_ITEMS),
    });
    entry.lastAt = Math.max(entry.lastAt, s.time_updated);
    if (open) entry.open++;
    byProject.set(directory, entry);
  }
  const projects = [...byProject.values()].sort((a, b) => b.lastAt - a.lastAt);
  // Unfinished first, then the most recent.
  for (const p of projects) p.sessions.sort((a, b) => Number(b.open) - Number(a.open) || b.lastAt - a.lastAt);
  return {
    range: { from, to: now, days },
    total: top.length,
    open: projects.reduce((n, p) => n + p.open, 0),
    projects,
  };
}

/** Reads what tasksOf needs from the database; cached for a minute per period. */
export function createTasksSource({ db, show, liveState = () => null }) {
  const cache = new Map();
  return function tasks(askedDays, now = Date.now()) {
    const days = TASK_DAYS.includes(askedDays) ? askedDays : 7;
    const hit = cache.get(days);
    if (hit && now - hit.at < 60_000) return hit.value;
    const since = now - days * 86_400_000;
    const sessions = db.stats.sessions(since);
    // The latest plan each session wrote. Its last todowrite may be older than the period: a
    // session updated lately whose plan was written before is read back further.
    const writes = new Map();
    for (const w of db.stats.todoWrites(since - 30 * 86_400_000).toSorted((a, b) => a.time_created - b.time_created)) writes.set(w.session_id, w.todos);
    const value = tasksOf({ sessions, tablePlan: id => db.todos(id), writes, lastMessages: id => db.lastMessages(id), liveState, show, now, days });
    cache.set(days, { at: now, value });
    return value;
  };
}
