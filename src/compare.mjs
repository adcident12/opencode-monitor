// Before and after a moment, such as a change to opencode.json: the same figures for the hours
// before it and the hours after it, each per hour of agent time, so two stretches of different
// amounts of work compare. Pure: rows in, figures out.
import { matchPrompts } from './stats.mjs';
import { fileKey, inProject } from './work.mjs';

const HOUR = 3_600_000;
// A call that ran this long is worth counting: a script or command that held the session up.
const LONG_CALL_MS = 120_000;
const LONG_CALLS_LISTED = 3;
// An edit this many calls after a re-read of the same file used what was read.
const EDIT_WITHIN_CALLS = 5;
const TOP_TOOLS = 8;
const FILE_EDITS = new Set(['edit', 'write', 'multiedit', 'apply_patch', 'patch']);

const startOf = p => p.started ?? p.time_created;
const round = (n, digits = 2) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10 ** digits) / 10 ** digits);
const modelOf = m => (m.provider_id ? `${m.provider_id}/${m.model_id}` : m.model_id);

/** Whether a read asked for part of a file (an offset or a limit) rather than all of it. */
function ranged(p) {
  if (p.read_offset != null || p.read_limit != null) return true;
  try {
    const input = JSON.parse(p.input ?? '{}');
    return input.offset != null || input.limit != null;
  } catch {
    return false;
  }
}

/**
 * Files read again after a compaction: a file read before a compaction and read again after
 * it, counted once per file and compaction (the first read after it), by kind: whole or a
 * range, and whether an edit of the same file followed within a few calls (the read was for
 * changing it) or not (for looking).
 */
function rereadsAfterCompaction({ tools, compactions, sessionIds, dirOf, from, to, counts }) {
  const out = { total: 0, whole: 0, ranged: 0, thenEdited: 0 };
  for (const id of sessionIds) {
    const calls = tools.filter(p => p.session_id === id).sort((a, b) => startOf(a) - startOf(b));
    const cuts = [...new Set(compactions.filter(c => c.session_id === id).map(c => c.time_created))].sort((a, b) => a - b);
    if (!cuts.length) continue;
    const key = p => fileKey(inProject(p.file, dirOf(id)));
    const seenAfter = new Set(); // "cut|file" already counted
    const readAt = new Map(); // file -> first read time
    calls.forEach((p, i) => {
      if (p.tool !== 'read' || !p.file || p.status !== 'completed') return;
      const t = startOf(p);
      const file = key(p);
      const firstRead = readAt.get(file);
      if (firstRead == null) readAt.set(file, t);
      const cut = cuts.findLast(c => c <= t);
      if (cut == null || firstRead == null || firstRead >= cut) return;
      if (seenAfter.has(`${cut}|${file}`)) return;
      seenAfter.add(`${cut}|${file}`);
      if (t < from || t >= to || !counts(p)) return;
      out.total++;
      out[ranged(p) ? 'ranged' : 'whole']++;
      if (calls.slice(i + 1, i + 1 + EDIT_WITHIN_CALLS).some(q => FILE_EDITS.has(q.tool) && q.file && key(q) === file)) out.thenEdited++;
    });
  }
  return out;
}

/** The figures of one stretch of time [from, to), for the sessions and model in scope. */
function side(input, from, to, inScope, model) {
  const { messages, tools, compactions, spans, sessions } = input;
  const show = input.show ?? (text => String(text ?? ''));
  const clip = (start, end) => Math.max(0, Math.min(end, to) - Math.max(start, from));
  const ofModel = m => !model || modelOf(m) === model;
  const all = messages.filter(m => m.role === 'assistant' && inScope(m.session_id));
  const byId = new Map(all.map(m => [m.id, m]));
  // A compaction is the work of the model that was answering in its session before it.
  const work = all.filter(m => m.agent !== 'compaction').sort((a, b) => a.time_created - b.time_created);
  const answering = (sessionId, t) => work.findLast(m => m.session_id === sessionId && m.time_created <= t);
  const counts = m => m && (m.agent === 'compaction' ? (!model || (answering(m.session_id, m.time_created) && ofModel(answering(m.session_id, m.time_created)))) : ofModel(m));
  const replies = all.filter(counts);
  // A call counts for the model of the reply it was made in; without one, when no model is asked for.
  const callCounts = p => !model || counts(byId.get(p.message_id));

  const activeMs = replies.reduce((n, m) => n + clip(m.time_created, m.completed ?? m.time_created), 0);
  const hours = activeMs / HOUR;
  const perHour = n => (hours > 0 ? round(n / hours) : null);

  const compacting = replies.filter(m => m.agent === 'compaction' && m.time_created >= from && m.time_created < to);
  const compactingMs = compacting.reduce((n, m) => n + Math.max(0, (m.completed ?? m.time_created) - m.time_created), 0);
  const calls = tools.filter(p => inScope(p.session_id) && startOf(p) >= from && startOf(p) < to && callCounts(p));
  const runMs = p => (p.ended != null && p.started != null ? p.ended - p.started : null);

  const perTool = new Map();
  for (const p of calls) {
    const e = perTool.get(p.tool) ?? { tool: p.tool, calls: 0, failed: 0 };
    e.calls++;
    if (p.status === 'error') e.failed++;
    perTool.set(p.tool, e);
  }
  // A question waits for you, not for the tool: that time is the permission and question waits.
  const long = calls.filter(p => p.tool !== 'question' && runMs(p) > LONG_CALL_MS).sort((a, b) => runMs(b) - runMs(a));
  const longByTool = new Map();
  for (const p of long) longByTool.set(p.tool, (longByTool.get(p.tool) ?? 0) + 1);

  // Thinking inside the replies counted: with a model asked for, only those of that model.
  const inReply = s => !model || replies.some(m => m.session_id === s.session_id && m.time_created <= s.s && s.s <= (m.completed ?? m.time_created));
  const thinkingMs = spans.filter(s => inScope(s.session_id) && s.type === 'reasoning' && s.s != null && s.e != null && inReply(s)).reduce((n, s) => n + clip(s.s, s.e), 0);
  const prompts = matchPrompts({ asks: input.asks.filter(a => a.t >= from && a.t < to), replies: input.replies, tools: input.tools, eventTimes: input.eventTimes, now: input.now })
    .filter(p => p.kind === 'permission' && p.part && inScope(p.part.session_id) && callCounts(p.part));
  const sessionIds = [...new Set(calls.map(p => p.session_id))];
  const dirOf = id => sessions.find(s => s.id === id)?.directory;
  const models = new Map();
  for (const m of replies) if (m.model_id && m.agent !== 'compaction' && m.time_created >= from && m.time_created < to) models.set(modelOf(m), (models.get(modelOf(m)) ?? 0) + 1);

  return {
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    agentHours: round(hours),
    models: [...models].sort((a, b) => b[1] - a[1]).map(([name, n]) => ({ model: name, replies: n })),
    compactions: { count: compacting.length, perHour: perHour(compacting.length), averageMs: compacting.length ? Math.round(compactingMs / compacting.length) : null },
    rereadsAfterCompaction: rereadsAfterCompaction({ tools, compactions, sessionIds, dirOf, from, to, counts: callCounts }),
    longCalls: {
      over: `${LONG_CALL_MS / 1000}s`,
      count: long.length,
      perHour: perHour(long.length),
      byTool: Object.fromEntries([...longByTool].sort((a, b) => b[1] - a[1])),
      // What the longest were: a command that waits on a build is not a hang.
      longest: long.slice(0, LONG_CALLS_LISTED).map(p => ({ tool: p.tool, ms: runMs(p), what: show(p.cmd ?? p.code ?? p.descr ?? p.url ?? p.file ?? '', 120) })),
    },
    interrupted: { count: replies.filter(m => m.error_name === 'MessageAbortedError' && m.time_created >= from && m.time_created < to).length },
    thinkingPct: activeMs ? Math.round((thinkingMs / activeMs) * 100) : null,
    toolFailures: [...perTool.values()].sort((a, b) => b.calls - a.calls).slice(0, TOP_TOOLS).map(e => ({ ...e, pct: round((e.failed / e.calls) * 100, 1) })),
    permissionWaits: { count: prompts.length, waitedMs: prompts.reduce((n, p) => n + (p.answeredAt != null || p.abandoned ? p.waitMs : 0), 0) },
  };
}

/**
 * @param {object} input  the rows Stats is computed from (see createStatsSource)
 * @param {number} at     the moment to compare around, such as when a setting changed
 * @param {number} hours  how far to look each way; cut short by the data or by now
 * @param {Set<string>|null} scope  sessions to count (one and its subagents), or all
 * @param {string|null} model  "provider/model": only the work of that model, on both sides
 */
export function compareAt(input, at, hours, scope = null, model = null) {
  const inScope = id => !scope || scope.has(id);
  const first = Math.min(...input.messages.map(m => m.time_created), at);
  // Each side as long as there is, up to `hours`: the figures are per hour of agent time, so
  // a short side after a recent change still compares.
  const back = Math.min(hours * HOUR, at - first);
  const ahead = Math.min(hours * HOUR, input.now - at);
  if (Number.isNaN(back + ahead) || back <= 0 || ahead <= 0) return { at: new Date(at).toISOString(), error: 'no time on one side of this moment in the period read' };
  const before = side(input, at - back, at, inScope, model);
  const after = side(input, at, at + ahead, inScope, model);
  const enough = before.agentHours >= 1 && after.agentHours >= 1;
  // Every figure moves with the model: a stretch that is not the same model on both sides says
  // more about the model than about the change.
  const one = list => (list.length === 1 ? list[0].model : null);
  const sameModel = one(before.models) != null && one(before.models) === one(after.models);
  let note = null;
  const whose = model ? ` of ${model}` : '';
  if (!enough) note = `Agent time${whose}: ${before.agentHours} h before, ${after.agentHours} h after. Under an hour on a side is too little to say much.`;
  else if (!sameModel) note = 'The model was not the same on both sides: every figure moves with the model, so this compares models as much as the change. Give `model` to compare one model only.';
  return {
    at: new Date(at).toISOString(),
    ...(model ? { model } : {}),
    hoursBefore: round(back / HOUR, 1),
    hoursAfter: round(ahead / HOUR, 1),
    reliable: enough && sameModel,
    note,
    before,
    after,
  };
}
