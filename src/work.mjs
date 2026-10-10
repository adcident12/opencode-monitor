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
function endingOf(last, now, followed) {
  if (!last) return followed ? 'continued' : 'open';
  if (last.error_name === 'MessageAbortedError') return 'aborted';
  if (last.error_name) return 'error';
  if (last.finish === 'stop') return 'done';
  if (last.finish === 'length') return 'cut';
  if (followed) return 'continued';
  // The last prompt of its session, stopped after a tool call: still going, or left so.
  return now - (last.completed ?? last.time_created) < OPEN_MS ? 'open' : 'unanswered';
}

/**
 * Each prompt you wrote and what came of it: replies until your next prompt. A compaction
 * writes a user message of its own; that is part of the turn, not a new one.
 */
export function turnsOf(ctx, { messages, where, show }) {
  const bySession = new Map();
  for (const m of messages) {
    const s = ctx.sessionById.get(m.session_id);
    if (!s || s.parent_id || !ctx.inScope(m.session_id)) continue;
    if (!bySession.has(m.session_id)) bySession.set(m.session_id, []);
    bySession.get(m.session_id).push(m);
  }
  const turns = [];
  for (const list of bySession.values()) {
    list.sort((a, b) => a.time_created - b.time_created || (a.role === 'user' ? -1 : 1));
    let turn = null;
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      if (m.role === 'user') {
        const byCompaction = list[i + 1]?.role === 'assistant' && list[i + 1].agent === 'compaction';
        if (!byCompaction) {
          if (turn) turn.followed = true;
          turn = { session: m.session_id, at: m.time_created, replies: [], followed: false };
          turns.push(turn);
        }
      } else if (turn && m.agent !== 'compaction' && !m.summary) {
        turn.replies.push(m);
      }
    }
  }
  const inRange = turns.filter(t => t.at >= ctx.from && t.at <= ctx.now);
  const ended = { done: 0, cut: 0, aborted: 0, error: 0, continued: 0, unanswered: 0, open: 0 };
  const cut = [];
  for (const t of inRange) {
    const last = t.replies.at(-1);
    t.ending = endingOf(last, ctx.now, t.followed);
    t.ms = last ? Math.max(0, (last.completed ?? last.time_created) - t.at) : 0;
    ended[t.ending]++;
    if (t.ending === 'cut') cut.push({ at: last.time_created, model: last.model_id ? show(`${last.provider_id ?? ''}/${last.model_id}`.replace(/^\//, ''), 80) : null, ...where(t.session) });
  }
  const finished = inRange.filter(t => t.ending !== 'open');
  return {
    count: inRange.length,
    ended,
    medianSteps: median(finished.map(t => t.replies.length)),
    medianMs: median(finished.map(t => t.ms)),
    longestMs: finished.length ? Math.max(...finished.map(t => t.ms)) : null,
    cut: cut.sort((a, b) => b.at - a.at).slice(0, TOP),
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

/** Files the agent changed, from the patches OpenCode records after each edit. */
export function filesOf(ctx, { patches, where, show, relative }) {
  const times = new Map(); // session|file -> how many patches touched it
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
      distinct.add(file);
      add(times, `${ctx.rootOf(p.session_id)}|${file}`);
    }
  }
  const top = [...times]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP)
    .map(([key, count]) => {
      const cut = key.indexOf('|');
      const session = key.slice(0, cut);
      const file = key.slice(cut + 1);
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

/**
 * The agent's own task lists, per session in the period. A finished session with items still
 * pending is a plan that was left, not one that is in progress.
 * @param {object[]} todos  { session_id, status }
 */
export function plansOf(ctx, { todos, where }) {
  const per = new Map();
  for (const item of todos) {
    const s = ctx.sessionById.get(item.session_id);
    if (!s || !ctx.inScope(item.session_id) || (s.time_updated ?? s.time_created) < ctx.from) continue;
    const root = ctx.rootOf(item.session_id);
    const p = per.get(root) ?? { id: root, total: 0, completed: 0, inProgress: 0, pending: 0, cancelled: 0 };
    p.total++;
    if (item.status === 'completed') p.completed++;
    else if (item.status === 'in_progress') p.inProgress++;
    else if (item.status === 'cancelled') p.cancelled++;
    else p.pending++;
    per.set(root, p);
  }
  const sessions = [...per.values()];
  const sum = key => sessions.reduce((n, p) => n + p[key], 0);
  return {
    sessions: sessions.length,
    total: sum('total'),
    completed: sum('completed'),
    inProgress: sum('inProgress'),
    pending: sum('pending'),
    cancelled: sum('cancelled'),
    unfinished: sessions
      .filter(p => p.pending + p.inProgress > 0)
      .sort((a, b) => b.pending + b.inProgress - (a.pending + a.inProgress))
      .slice(0, TOP)
      .map(p => ({ ...p, ...where(p.id) })),
  };
}
