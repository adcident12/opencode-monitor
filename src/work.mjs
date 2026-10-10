// Everything about a period that is not one tool call: where the agent's time went, how each
// of your prompts ended, which permissions interrupted you, which files changed, which agents
// did the work, and how the agent's own plans came out. Pure: rows in, figures out.
//
// Each part is shown only when this machine has data for it: someone who never uses todos, or
// whose OpenCode does not record reasoning, gets no empty section for it.

const TOP = 10;
// A prompt whose last reply came this recently may still be going.
const OPEN_MS = 10 * 60_000;

const median = values => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
};
const add = (map, key, n = 1) => map.set(key, (map.get(key) ?? 0) + n);

/**
 * Where the agent's time went, per day: the wait for a reply to start (the model reading the
 * prompt), thinking, writing, tools running. Time waiting for you is counted elsewhere.
 * @param {object[]} spans  { session_id, type: 'reasoning'|'text', s, e }
 * @param {object[]} calls  tool calls counted in the period, with runMs
 */
export function timeSplit(ctx, { spans, calls, messages, steps }) {
  const total = { readingMs: 0, thinkingMs: 0, writingMs: 0, toolMs: 0 };
  const bump = (t, key, ms) => {
    const b = ctx.bucket(t);
    if (!b || !(ms > 0)) return;
    b[key] += ms;
    total[key] += ms;
  };
  for (const span of spans) {
    if (!ctx.inScope(span.session_id) || span.e == null || span.s == null) continue;
    bump(span.s, span.type === 'reasoning' ? 'thinkingMs' : 'writingMs', span.e - span.s);
  }
  for (const call of calls) bump(call.at, 'toolMs', call.runMs ?? 0);
  for (const m of messages) {
    const step = steps.get(m.id);
    if (m.role !== 'assistant' || !ctx.inScope(m.session_id) || step?.first_token == null) continue;
    bump(m.time_created, 'readingMs', step.first_token - m.time_created);
  }
  return total;
}

/**
 * How a prompt's last reply ended. A prompt that you followed with another before a final
 * answer is "continued": you steered it, the work went on in the next one.
 */
export function endingOf(last, now, followed) {
  if (!last) return followed ? 'continued' : 'open';
  if (last.error_name === 'MessageAbortedError') return 'aborted';
  if (last.error_name) return 'error';
  if (last.finish === 'stop') return 'done';
  if (last.finish === 'length') return 'cut';
  if (followed) return 'continued';
  // The last prompt of its session, stopped after a tool call: still going, or left so.
  return now - (last.completed ?? last.time_created) < OPEN_MS ? 'open' : 'unanswered';
}

const pushTo = (map, key, value) => {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
};

const isCompaction = m => m?.role === 'assistant' && m.agent === 'compaction';

/** One session's messages cut into turns: a prompt of yours and the replies up to the next. */
export function turnsOfSession(list) {
  list.sort((a, b) => a.time_created - b.time_created || (a.role === 'user' ? -1 : 1));
  const turns = [];
  let turn = null;
  list.forEach((m, i) => {
    // The user message a compaction writes belongs to the turn it interrupts.
    if (m.role === 'user' && !isCompaction(list[i + 1])) {
      if (turn) turn.followed = true;
      turn = { session: m.session_id, at: m.time_created, replies: [], followed: false };
      turns.push(turn);
    } else if (m.role !== 'user' && turn && m.agent !== 'compaction' && !m.summary) {
      turn.replies.push(m);
    }
  });
  return turns;
}

/**
 * Each prompt you wrote and what came of it: replies until your next prompt. A compaction
 * writes a user message of its own; that is part of the turn, not a new one.
 */
export function turnsOf(ctx, { messages, where, show }) {
  const bySession = new Map();
  for (const m of messages) {
    const s = ctx.sessionById.get(m.session_id);
    if (s && !s.parent_id && ctx.inScope(m.session_id)) pushTo(bySession, m.session_id, m);
  }
  const turns = [...bySession.values()].flatMap(turnsOfSession);
  const inRange = turns.filter(t => t.at >= ctx.from && t.at <= ctx.now);
  const ended = { done: 0, cut: 0, aborted: 0, error: 0, continued: 0, unanswered: 0, open: 0 };
  const cut = [];
  for (const t of inRange) {
    const last = t.replies.at(-1);
    t.ending = endingOf(last, ctx.now, t.followed);
    t.ms = last ? Math.max(0, (last.completed ?? last.time_created) - t.at) : 0;
    ended[t.ending]++;
    if (last && t.ending === 'cut') cut.push({ at: last.time_created, model: last.model_id ? show(`${last.provider_id ?? ''}/${last.model_id}`.replace(/^\//, ''), 80) : null, ...where(t.session) });
  }
  const finished = inRange.filter(t => t.ending !== 'open');
  return {
    count: inRange.length,
    ended,
    medianSteps: median(finished.map(t => t.replies.length)),
    medianMs: median(finished.map(t => t.ms)),
    longestMs: finished.length ? Math.max(...finished.map(t => t.ms)) : null,
    cut: cut.toSorted((a, b) => b.at - a.at).slice(0, TOP),
  };
}

/** Which permission prompts interrupted you most, by what they asked to run. */
export function permissionsOf(prompts, show) {
  const groups = new Map();
  for (const p of prompts) {
    if (p.kind !== 'permission' || !p.permission) continue;
    const key = `${p.permission}|${p.patterns ?? ''}`;
    const g = groups.get(key) ?? { permission: show(p.permission, 60), pattern: show(p.patterns ?? '', 200), count: 0, waitMs: 0, lastAt: 0 };
    g.count++;
    if (p.answeredAt != null) g.waitMs += p.waitMs;
    g.lastAt = Math.max(g.lastAt, p.t);
    groups.set(key, g);
  }
  const all = [...groups.values()].sort((a, b) => b.count - a.count || b.lastAt - a.lastAt);
  return { asked: all.reduce((n, g) => n + g.count, 0), top: all.slice(0, TOP) };
}

/**
 * One key per file: on Windows the same file arrives with either slash and in any letter case.
 * The session cards count files the same way, so the two never disagree.
 */
export const fileKey = (path, platform = process.platform) => (platform === 'win32' ? path.replaceAll('\\', '/').toLowerCase() : path);

/** Files the agent changed, from the patches OpenCode records after each edit. */
export function filesOf(ctx, { patches, where, show, relative, platform = process.platform }) {
  const times = new Map(); // session|file key -> how many patches touched it
  const firstSeen = new Map(); // file key -> the path as first written, for display
  const distinct = new Set();
  let edits = 0;
  for (const p of patches) {
    if (!ctx.inScope(p.session_id) || p.time_created < ctx.from) continue;
    let files;
    try {
      files = JSON.parse(p.files ?? '[]').filter(f => typeof f === 'string');
    } catch {
      continue;
    }
    if (!files.length) continue;
    edits++;
    const b = ctx.bucket(p.time_created);
    if (b) b.files += files.length;
    for (const file of files) {
      const key = fileKey(file, platform);
      distinct.add(key);
      if (!firstSeen.has(key)) firstSeen.set(key, file);
      add(times, `${ctx.rootOf(p.session_id)}|${key}`);
    }
  }
  const top = [...times]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP)
    .map(([key, count]) => {
      const cut = key.indexOf('|');
      const session = key.slice(0, cut);
      const file = firstSeen.get(key.slice(cut + 1));
      return { file: show(relative(file, ctx.sessionById.get(session)?.directory), 200), count, ...where(session) };
    });
  return { edits, files: distinct.size, top };
}

/** Time, requests, tokens and cost per agent, subagents included. */
export function agentsOf(ctx, messages) {
  const per = new Map();
  for (const m of messages) {
    if (m.role !== 'assistant' || !ctx.inScope(m.session_id) || m.time_created < ctx.from) continue;
    const name = m.agent || 'unknown';
    const a = per.get(name) ?? { agent: name, requests: 0, activeMs: 0, tokens: 0, cost: 0, inChild: 0 };
    a.requests++;
    const end = Math.min(m.completed ?? m.time_created, ctx.now);
    if (end > m.time_created) a.activeMs += end - m.time_created;
    a.tokens += (m.tokens_input ?? 0) + (m.tokens_cache_read ?? 0) + (m.tokens_cache_write ?? 0) + (m.tokens_output ?? 0);
    a.cost += m.cost ?? 0;
    if (ctx.sessionById.get(m.session_id)?.parent_id) a.inChild++;
    per.set(name, a);
  }
  // A subagent is one that only ever ran in sessions another agent started.
  return [...per.values()]
    .map(({ inChild, ...a }) => ({ ...a, subagent: inChild === a.requests, cost: Math.round(a.cost * 10_000) / 10_000 }))
    .sort((a, b) => b.activeMs - a.activeMs);
}

const DONE = new Set(['completed', 'cancelled']);

// An item written again in other words is the same item, not one dropped and one new. Two
// texts are taken as the same when most of the words of the shorter one are in the other.
const SAME_ITEM = 0.6;
const wordsOf = text => new Set(text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').split(' ').filter(w => w.length > 2));
export function sameItem(a, b) {
  const A = wordsOf(a);
  const B = wordsOf(b);
  if (!A.size || !B.size) return false;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return shared / Math.min(A.size, B.size) >= SAME_ITEM;
}

/**
 * One session's plan, followed through every list the agent wrote. Each todowrite replaces
 * the whole list, so an item can leave it in three ways: marked done, marked cancelled, or
 * simply not written again. The last is "dropped": the plan changed under it.
 * Items are told apart by their text, which is used here and never kept or shown.
 * @param {string[][]} lists  each list, oldest first, as [text, status] pairs
 */
export function followPlan(lists) {
  const items = new Map(); // text -> status
  let dropped = 0;
  let rewrites = 0;
  for (const list of lists) {
    const now = new Map(list);
    const added = [...now.keys()].filter(text => !items.has(text));
    let replaced = false;
    for (const [text, status] of [...items]) {
      if (now.has(text) || DONE.has(status) || status === 'dropped') continue;
      // Reworded in this list: carry the item over under its new words.
      const renamed = added.findIndex(other => sameItem(text, other));
      if (renamed !== -1) {
        added.splice(renamed, 1);
        items.delete(text);
        continue;
      }
      items.set(text, 'dropped');
      dropped++;
      replaced = true;
    }
    if (replaced) rewrites++;
    for (const [text, status] of now) items.set(text, status);
  }
  const statuses = [...items.values()];
  const count = s => statuses.filter(x => x === s).length;
  return {
    total: items.size,
    completed: count('completed'),
    cancelled: count('cancelled'),
    dropped,
    inProgress: count('in_progress'),
    pending: count('pending'),
    rewrites,
  };
}

/** The list one todowrite call wrote, as [text, status] pairs; null when it cannot be read. */
function planOf(call) {
  let list;
  try {
    list = JSON.parse(call.todos ?? '[]');
  } catch {
    return null;
  }
  if (!Array.isArray(list)) return null;
  return list.filter(i => i && typeof i.content === 'string').map(i => [i.content, String(i.status ?? 'pending')]);
}

/**
 * The agent's own task lists, per session in the period, rebuilt from every list it wrote.
 * The todo table is only a fallback, for sessions with no todowrite call at all (an OpenCode
 * that records plans differently). It holds a session's latest list, whenever that was
 * written, so for a session with todowrite calls it would put a list from before the period
 * into it.
 * @param {object[]} todos       { session_id, status } from the todo table
 * @param {object[]} todoWrites  { session_id, time_created, todos: JSON } from todowrite calls
 * @param {Set<string>} todoWriters  sessions with a todowrite call at any time
 */
export function plansOf(ctx, { todos, todoWrites = [], todoWriters = new Set(), where }) {
  const listsBySession = new Map();
  for (const call of todoWrites.toSorted((x, y) => x.time_created - y.time_created)) {
    const pairs = ctx.inScope(call.session_id) && call.time_created >= ctx.from ? planOf(call) : null;
    if (pairs) pushTo(listsBySession, call.session_id, pairs);
  }

  const per = new Map(); // top-level session -> totals
  const merge = (session, plan) => {
    const root = ctx.rootOf(session);
    const p = per.get(root) ?? { id: root, total: 0, completed: 0, cancelled: 0, dropped: 0, inProgress: 0, pending: 0, rewrites: 0 };
    for (const key of ['total', 'completed', 'cancelled', 'dropped', 'inProgress', 'pending', 'rewrites']) p[key] += plan[key];
    per.set(root, p);
  };
  for (const [session, lists] of listsBySession) merge(session, followPlan(lists));

  // Sessions that never wrote a list through todowrite: what the todo table holds.
  const fromTable = new Map();
  const onlyInTable = id => {
    const s = ctx.sessionById.get(id);
    return Boolean(s) && !todoWriters.has(id) && !listsBySession.has(id) && ctx.inScope(id) && (s.time_updated ?? s.time_created) >= ctx.from;
  };
  for (const item of todos) {
    if (onlyInTable(item.session_id)) pushTo(fromTable, item.session_id, [String(fromTable.get(item.session_id)?.length ?? 0), item.status]);
  }
  for (const [session, pairs] of fromTable) merge(session, followPlan([pairs]));

  const sessions = [...per.values()];
  const sum = key => sessions.reduce((n, p) => n + p[key], 0);
  const open = p => p.pending + p.inProgress + p.dropped;
  return {
    sessions: sessions.length,
    total: sum('total'),
    completed: sum('completed'),
    cancelled: sum('cancelled'),
    dropped: sum('dropped'),
    inProgress: sum('inProgress'),
    pending: sum('pending'),
    rewrites: sum('rewrites'),
    unfinished: sessions
      .filter(p => open(p) > 0)
      .sort((x, y) => open(y) - open(x))
      .slice(0, TOP)
      .map(p => ({ ...p, ...where(p.id) })),
  };
}
