// Looking back over days rather than at the moment: how long prompts waited for you, which
// calls hung, how the agent spends its tool calls. Pure: rows in, figures out.
import { promptFits } from './audit.mjs';

const ASK_MATCH_MS = 2000;
// An update to a tool call this soon after its prompt is the prompt being drawn, not answered.
const ANSWER_MIN_MS = 500;
const TOP = 10;

/** Local calendar day, YYYY-MM-DD. */
export function dayKey(t) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function dayRange(now, days) {
  const keys = [];
  const d = new Date(now);
  d.setHours(12, 0, 0, 0); // noon, so daylight-saving shifts never skip or repeat a day
  for (let i = days - 1; i >= 0; i--) keys.push(dayKey(d.getTime() - i * 86_400_000));
  return keys;
}

const median = values => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
};

const startOf = p => p.started ?? p.time_created;
const isExploreTool = tool => tool === 'read' || tool === 'grep' || tool === 'glob';
const isGraft = tool => /^graft_/.test(tool);

/**
 * Pairs each prompt from the log with what answered it.
 * Questions: OpenCode logs the reply. Permissions: it does not, so the answer is the first
 * update to the tool call after the prompt (approving resumes it, refusing ends it).
 */
export function matchPrompts({ asks, replies, tools, eventTimes, now, movedOn = () => null, currentRun = null, runEnds = new Map() }) {
  const byStart = [...tools].sort((a, b) => startOf(a) - startOf(b));
  const prompts = [];
  // Without an answer, a prompt ends when its session moved on without it (a new message), or
  // when the OpenCode process that asked has exited. Only otherwise is it still open.
  const settle = (ask, part, answeredAt) => {
    let abandonedAt = null;
    if (answeredAt == null) {
      // Whichever came first: the session moving on, or the asking process going away.
      const candidates = [];
      const next = part ? movedOn(part.session_id, ask.t) : null;
      if (next != null) candidates.push(next);
      if (ask.run && currentRun && ask.run !== currentRun) candidates.push(Math.max(ask.t, runEnds.get(ask.run) ?? ask.t));
      if (candidates.length) abandonedAt = Math.min(...candidates);
    }
    return { ...ask, part, answeredAt, abandonedAt, abandoned: abandonedAt != null, waitMs: (answeredAt ?? abandonedAt ?? now) - ask.t };
  };
  for (const ask of asks) {
    if (ask.kind === 'question') {
      const part = nearest(byStart, ask.t, p => p.tool === 'question');
      prompts.push(settle(ask, part, replies.get(ask.id) ?? null));
      continue;
    }
    const part = nearest(byStart, ask.t, p => promptFits(ask, p.tool));
    let answeredAt = null;
    if (part) {
      const after = (eventTimes.get(part.id) ?? []).find(t => t >= ask.t + ANSWER_MIN_MS);
      if (after != null) answeredAt = after;
      else if (part.status !== 'running' && part.status !== 'pending') answeredAt = Math.max(ask.t, part.time_updated);
    }
    prompts.push(settle(ask, part, answeredAt));
  }
  return prompts;
}

/** (sessionId, t) -> time of the first message in that session after t, or null. */
function nextMessageFinder(messages) {
  const bySession = new Map();
  for (const m of messages) {
    if (!bySession.has(m.session_id)) bySession.set(m.session_id, []);
    bySession.get(m.session_id).push(m.time_created);
  }
  for (const times of bySession.values()) times.sort((a, b) => a - b);
  return (sessionId, t) => bySession.get(sessionId)?.find(x => x > t + ANSWER_MIN_MS) ?? null;
}

function nearest(sorted, t, fits) {
  let best = null;
  for (const p of sorted) {
    const gap = Math.abs(startOf(p) - t);
    if (startOf(p) > t + ASK_MATCH_MS) break;
    if (gap <= ASK_MATCH_MS && fits(p) && (!best || gap < Math.abs(startOf(best) - t))) best = p;
  }
  return best;
}

/**
 * @param {object} input
 * @param {object[]} input.sessions   id, title, directory, parent_id, time_created
 * @param {object[]} input.tools      tool parts started in the range
 * @param {object[]} input.messages   session_id, role, time_created, completed
 * @param {object[]} input.compactions session_id, time_created
 * @param {object[]} input.asks       prompts from the log, in the range
 * @param {Map<string, number>} input.replies question id -> answer time
 * @param {Map<string, number[]>} input.eventTimes tool part id -> update times, ascending
 * @param {(text: string) => string} input.show redact and shorten for display
 */
export function computeStats({ sessions, tools, messages, compactions, asks, replies, eventTimes, now, days, stuckMs, show, currentRun = null, runEnds = new Map() }) {
  const keys = dayRange(now, days);
  const from = new Date(`${keys[0]}T00:00:00`).getTime();
  const daily = new Map(keys.map(k => [k, { date: k, activeMs: 0, waitMs: 0, prompts: 0, stuck: 0, abandoned: 0, toolCalls: 0, toolErrors: 0, compactions: 0, sessions: 0 }]));
  const bucket = t => daily.get(dayKey(t));
  const sessionById = new Map(sessions.map(s => [s.id, s]));
  const where = id => {
    const s = sessionById.get(id);
    const directory = s?.directory ?? '';
    return { project: show(directory.split(/[\\/]/).filter(Boolean).pop() ?? '', 80), title: show(s?.title ?? '', 120) };
  };

  for (const s of sessions) if (s.time_created >= from && !s.parent_id) bucket(s.time_created) && bucket(s.time_created).sessions++;
  for (const c of compactions) bucket(c.time_created) && bucket(c.time_created).compactions++;

  // Agent time: from each model request to its reply, clipped to the range.
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    const start = Math.max(m.time_created, from);
    const end = Math.min(m.completed ?? m.time_created, now);
    if (end > start && bucket(start)) bucket(start).activeMs += end - start;
  }

  // Prompts: how long each one waited for an answer.
  const inRange = asks.filter(a => a.t >= from && a.t <= now);
  const movedOn = nextMessageFinder(messages);
  const prompts = matchPrompts({ asks: inRange, replies, tools, eventTimes, now, movedOn, currentRun, runEnds });
  const waitByPart = new Map();
  const deadAt = new Map(); // tool part id -> when the process that prompted for it went away
  for (const p of prompts) if (p.part && p.abandonedAt != null) deadAt.set(p.part.id, p.abandonedAt);
  for (const p of prompts) {
    const b = bucket(p.t);
    if (b) {
      b.prompts++;
      b.waitMs += p.waitMs;
    }
    if (p.part) waitByPart.set(p.part.id, (waitByPart.get(p.part.id) ?? 0) + (p.answeredAt ? p.waitMs : 0));
  }

  // Tool calls: counts, errors, and how long each ran once it was allowed to.
  const perTool = new Map();
  const slow = [];
  const reads = new Map(); // session|file -> count
  const skills = new Map();
  let graft = 0;
  let explore = 0;
  for (const p of tools) {
    const t = startOf(p);
    const b = bucket(t);
    if (!b) continue;
    b.toolCalls++;
    const entry = perTool.get(p.tool) ?? { tool: p.tool, count: 0, errors: 0, totalMs: 0 };
    entry.count++;
    if (p.status === 'error') {
      entry.errors++;
      b.toolErrors++;
    }
    // A call with no end either still runs, or was left behind when its session moved on.
    const unfinished = p.ended == null && (p.status === 'running' || p.status === 'pending');
    const leftAt = unfinished ? (movedOn(p.session_id, t) ?? deadAt.get(p.id) ?? null) : null;
    if (leftAt != null) {
      // Left behind by a crash or abort: how long it "ran" says nothing about the command.
      b.abandoned++;
    } else {
      const end = p.ended ?? (unfinished ? now : null);
      const runMs = end == null ? null : Math.max(0, end - t - (waitByPart.get(p.id) ?? 0));
      if (runMs != null) {
        entry.totalMs += runMs;
        if (runMs > stuckMs) b.stuck++;
        slow.push({ p, runMs, running: unfinished });
      }
    }
    perTool.set(p.tool, entry);
    if (isGraft(p.tool)) graft++;
    else if (isExploreTool(p.tool)) explore++;
    if (p.tool === 'read' && p.file) reads.set(`${p.session_id}|${p.file}`, (reads.get(`${p.session_id}|${p.file}`) ?? 0) + 1);
    if (p.tool === 'skill' && p.skill) skills.set(p.skill, (skills.get(p.skill) ?? 0) + 1);
  }

  const answered = prompts.filter(p => p.answeredAt != null);
  const totals = {
    sessions: [...daily.values()].reduce((n, d) => n + d.sessions, 0),
    activeMs: [...daily.values()].reduce((n, d) => n + d.activeMs, 0),
    waitMs: [...daily.values()].reduce((n, d) => n + d.waitMs, 0),
    prompts: prompts.length,
    open: prompts.filter(p => p.answeredAt == null && !p.abandoned).length,
    abandoned: prompts.filter(p => p.abandoned).length,
    medianAnswerMs: median(answered.map(p => p.waitMs)),
    stuck: [...daily.values()].reduce((n, d) => n + d.stuck, 0),
    abandonedCalls: [...daily.values()].reduce((n, d) => n + d.abandoned, 0),
    toolCalls: [...daily.values()].reduce((n, d) => n + d.toolCalls, 0),
    toolErrors: [...daily.values()].reduce((n, d) => n + d.toolErrors, 0),
    compactions: [...daily.values()].reduce((n, d) => n + d.compactions, 0),
  };

  const describe = p => p.cmd ?? p.file ?? p.question ?? p.descr ?? '';
  return {
    range: { from, to: now, days },
    stuckMs,
    daily: [...daily.values()],
    totals,
    waits: [...prompts]
      .sort((a, b) => b.waitMs - a.waitMs)
      .slice(0, TOP)
      .map(p => ({
        at: p.t,
        kind: p.kind,
        permission: p.permission,
        detail: show(p.patterns || (p.part ? describe(p.part) : ''), 200),
        waitMs: p.waitMs,
        answered: p.answeredAt != null,
        abandoned: p.abandoned,
        ...(p.part ? where(p.part.session_id) : { project: '', title: '' }),
      })),
    slow: slow
      .sort((a, b) => b.runMs - a.runMs)
      .slice(0, TOP)
      .map(({ p, runMs, running }) => ({ at: startOf(p), tool: p.tool, text: show(describe(p), 200), runMs, status: p.status, running, ...where(p.session_id) })),
    tools: [...perTool.values()].sort((a, b) => b.count - a.count).slice(0, 15),
    explore: { graft, other: explore },
    rereads: [...reads]
      .filter(([, n]) => n >= 3)
      .sort((a, b) => b[1] - a[1])
      .slice(0, TOP)
      .map(([key, count]) => {
        const [sessionId, file] = key.split('|');
        return { file: show(file, 200), count, ...where(sessionId) };
      }),
    skills: [...skills].sort((a, b) => b[1] - a[1]).slice(0, TOP).map(([name, count]) => ({ name: show(name, 80), count })),
  };
}
