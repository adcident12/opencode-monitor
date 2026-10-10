// Looking back over days rather than at the moment: how long prompts waited for you, which
// calls hung, how the agent spends its tool calls. Pure: rows in, figures out.
import { promptFits } from './audit.mjs';
import { computeMcpStats } from './mcp.mjs';

const ASK_MATCH_MS = 2000;
// An update to a tool call this soon after its prompt is the prompt being drawn, not answered.
const ANSWER_MIN_MS = 500;
const TOP = 10;
const MAX_SESSIONS_LISTED = 100;
// Re-read files are the one ranking where the long tail is still worth reading.
const MAX_REREADS = 50;
// Below these a request says nothing about speed: a handful of tokens, or a clock too coarse.
const MIN_OUTPUT_TOKENS = 20;
const MIN_PROMPT_TOKENS = 500;
const MIN_TIMED_MS = 300;
const TOP_MODELS = 6;
const MAX_CONTEXT_POINTS = 240;

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
export function matchPrompts({ asks, replies, tools, eventTimes, now, movedOn = () => null, liveRuns = null, runEnds = new Map() }) {
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
      if (ask.run && liveRuns && !liveRuns.has(ask.run)) candidates.push(Math.max(ask.t, runEnds.get(ask.run) ?? ask.t));
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
 * How fast each model answers, from the requests that were long enough to tell.
 *   write speed  - output tokens per second, from the first token to the last thing written.
 *                  Tool run time and time spent waiting for you come after that, so are not in it.
 *   read speed   - new (uncached) prompt tokens per second, over the wait for the first token.
 * Totals over totals rather than an average of rates, so one tiny request cannot skew it.
 */
function computeSpeed({ requests, keys, show }) {
  const perModel = new Map();
  for (const r of requests) {
    const m = perModel.get(r.model) ?? { model: r.model, requests: 0, outTokens: 0, writeMs: 0, promptTokens: 0, readMs: 0, waits: [], days: new Map() };
    m.requests++;
    m.waits.push(r.firstTokenMs);
    if (r.output >= MIN_OUTPUT_TOKENS && r.writeMs >= MIN_TIMED_MS) {
      m.outTokens += r.output;
      m.writeMs += r.writeMs;
      const day = m.days.get(r.day) ?? { tokens: 0, ms: 0 };
      day.tokens += r.output;
      day.ms += r.writeMs;
      m.days.set(r.day, day);
    }
    if (r.input >= MIN_PROMPT_TOKENS && r.firstTokenMs >= MIN_TIMED_MS) {
      m.promptTokens += r.input;
      m.readMs += r.firstTokenMs;
    }
    perModel.set(r.model, m);
  }
  const rate = (tokens, ms) => (ms ? Math.round((tokens / ms) * 10_000) / 10 : null);
  const models = [...perModel.values()].sort((a, b) => b.outTokens - a.outTokens).slice(0, TOP_MODELS);
  return {
    models: models.map(m => ({
      model: show(m.model, 80),
      requests: m.requests,
      writeTps: rate(m.outTokens, m.writeMs),
      readTps: rate(m.promptTokens, m.readMs),
      firstTokenMs: median(m.waits),
      // One value per day of the range, null on days the model was not used.
      daily: keys.map(k => (m.days.has(k) ? rate(m.days.get(k).tokens, m.days.get(k).ms) : null)),
    })),
  };
}

/**
 * The few figures worth holding side by side when a setting was changed part-way through a
 * period. Everything is a rate or a typical value, never a total: the two halves are rarely
 * the same length.
 * @param {object} stats  a result of computeStats
 * @param {string|null} model  compare the speed of this model, so a switch of model does not
 *   pass for the server getting faster
 */
export function summarize(stats, model = null) {
  const { totals, usage } = stats;
  const per = n => (totals.sessions ? Math.round((n / totals.sessions) * 10) / 10 : null);
  const speed = stats.speed.models.find(m => m.model === model) ?? null;
  const mcpCalls = stats.mcp.reduce((n, m) => n + m.calls, 0);
  return {
    days: stats.range.days,
    sessions: totals.sessions,
    startTokens: usage.start?.median ?? null,
    compactionsPerSession: per(totals.compactions),
    rereadsPerSession: per(totals.rereads),
    toolCallsPerSession: per(totals.toolCalls),
    toolErrorPct: totals.toolCalls ? Math.round((totals.toolErrors / totals.toolCalls) * 1000) / 10 : null,
    mcpNoAnswerPct: mcpCalls ? Math.round((stats.mcp.reduce((n, m) => n + m.faults, 0) / mcpCalls) * 1000) / 10 : null,
    cachedPct: usage.cachedPct,
    // What OpenCode recorded as spent, per session; null for models that cost nothing.
    costPerSession: usage.cost > 0 && totals.sessions ? Math.round((usage.cost / totals.sessions) * 100) / 100 : null,
    writeTps: speed?.writeTps ?? null,
    firstTokenMs: speed?.firstTokenMs ?? null,
    medianAnswerMs: totals.medianAnswerMs,
  };
}

/**
 * How one session's context filled up: the size of each request, where it was compacted,
 * and how many files the agent then had to read a second time.
 * @param {object[]} requests     { t, tokens, model } of the session's own requests, oldest first
 * @param {number[]} compactions  times, ascending
 * @param {object[]} reads        { t, file } of its completed read calls, oldest first
 */
export function contextTimeline({ requests, compactions, reads, limit = null, compactAt = null }) {
  if (!requests.length) return null;
  const edges = [...compactions, Infinity];
  const marks = compactions.map((t, i) => {
    const seen = new Set(reads.filter(r => r.t < t).map(r => r.file));
    const again = new Set(reads.filter(r => r.t >= t && r.t < edges[i + 1] && seen.has(r.file)).map(r => r.file));
    return {
      t,
      // Index of the first request after the compaction, to place it on the chart.
      at: requests.findIndex(r => r.t >= t),
      before: requests.findLast(r => r.t < t)?.tokens ?? null,
      // Summaries are left out of `requests`, so this is the first request in the new context.
      after: requests.find(r => r.t >= t && r.t < edges[i + 1])?.tokens ?? null,
      reread: again.size,
    };
  });
  // Too many points to draw: keep the largest of each stretch, so no peak is lost.
  const step = Math.ceil(requests.length / MAX_CONTEXT_POINTS);
  const points = [];
  for (let i = 0; i < requests.length; i += step) {
    const chunk = requests.slice(i, i + step);
    points.push(chunk.reduce((a, b) => (b.tokens > a.tokens ? b : a)));
  }
  return {
    limit,
    compactAt,
    peak: Math.max(...requests.map(r => r.tokens)),
    requests: requests.length,
    points: points.map(p => ({ t: p.t, tokens: p.tokens })),
    compactions: marks.map(m => ({ ...m, at: m.at === -1 ? null : Math.floor(m.at / step) })),
    rereadAfterCompaction: marks.reduce((n, m) => n + m.reread, 0),
  };
}

/** The session itself and every subagent session under it. */
function withDescendants(sessions, sessionId) {
  const scope = new Set([sessionId]);
  // Parents are not guaranteed to come before their children, so repeat until nothing is added.
  for (let grew = true; grew;) {
    grew = false;
    for (const s of sessions) {
      if (s.parent_id && scope.has(s.parent_id) && !scope.has(s.id)) {
        scope.add(s.id);
        grew = true;
      }
    }
  }
  return scope;
}

// The three passes below share this: the day buckets and which sessions count.
// ctx = { from, now, bucket, inScope, sessionById, sessionId }

const tokensSent = m => (m.tokens_input ?? 0) + (m.tokens_cache_read ?? 0) + (m.tokens_cache_write ?? 0);

/** When a reply's first token arrived and when the model stopped writing, if both are known. */
function timingOf(m, step) {
  if (step?.first_token == null || step.written == null || step.written < step.first_token || !m.model_id) return null;
  return {
    model: m.provider_id ? `${m.provider_id}/${m.model_id}` : m.model_id,
    day: dayKey(m.time_created),
    input: (m.tokens_input ?? 0) + (m.tokens_cache_write ?? 0),
    output: (m.tokens_output ?? 0) + (m.tokens_reasoning ?? 0),
    firstTokenMs: Math.max(0, step.first_token - m.time_created),
    writeMs: step.written - step.first_token,
  };
}

/**
 * Model requests. Agent time: from each request to its reply, clipped to the range.
 * Tokens: what each request sent and got back, as the model server reported it.
 */
function tallyRequests(ctx, messages, steps) {
  const usage = { requests: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, cost: 0 };
  const firstRequest = new Map(); // session id -> { t, tokens } of its first request with a count
  const timed = []; // requests whose first token and last written token are both known
  const own = []; // the selected session's own requests, for its context timeline
  for (const m of messages) {
    if (m.role !== 'assistant' || !ctx.inScope(m.session_id)) continue;
    const start = Math.max(m.time_created, ctx.from);
    const end = Math.min(m.completed ?? m.time_created, ctx.now);
    if (end > start && ctx.bucket(start)) ctx.bucket(start).activeMs += end - start;

    const sent = tokensSent(m);
    const b = ctx.bucket(m.time_created);
    if (!b || !(sent + (m.tokens_output ?? 0) > 0)) continue;
    if (m.session_id === ctx.sessionId && sent > 0 && !m.summary) own.push({ t: m.time_created, tokens: sent, provider: m.provider_id, model: m.model_id });
    usage.requests++;
    usage.input += m.tokens_input ?? 0;
    usage.cacheRead += m.tokens_cache_read ?? 0;
    usage.cacheWrite += m.tokens_cache_write ?? 0;
    usage.output += m.tokens_output ?? 0;
    usage.reasoning += m.tokens_reasoning ?? 0;
    usage.cost += m.cost ?? 0;
    b.tokens += sent + (m.tokens_output ?? 0) + (m.tokens_reasoning ?? 0);
    b.cost += m.cost ?? 0;
    const timing = timingOf(m, steps.get(m.id));
    if (timing) timed.push(timing);
    const first = firstRequest.get(m.session_id);
    if (sent > 0 && (!first || m.time_created < first.t)) firstRequest.set(m.session_id, { t: m.time_created, tokens: sent });
  }
  // What a session costs before it has done anything: instructions, skills, and the tool
  // list of every MCP server that is switched on. Only top-level sessions that began in the
  // range, where the first request we see really is the session's first.
  const startSizes = [...firstRequest]
    .filter(([id]) => {
      const s = ctx.sessionById.get(id);
      return s && !s.parent_id && s.time_created >= ctx.from;
    })
    .map(([, first]) => first.tokens);
  own.sort((a, b) => a.t - b.t);
  return { usage, startSizes, timed, own };
}

/** Prompts: how long each one waited for an answer. */
function tallyPrompts(ctx, { asks, replies, tools, eventTimes, movedOn, liveRuns, runEnds, scope }) {
  const inRange = asks.filter(a => a.t >= ctx.from && a.t <= ctx.now);
  // Matched against every session's calls first, so a prompt is never pinned on this session
  // just because the call it really belonged to was left out.
  const all = matchPrompts({ asks: inRange, replies, tools, eventTimes, now: ctx.now, movedOn, liveRuns, runEnds });
  const prompts = all.filter(p => !scope || (p.part && scope.has(p.part.session_id)));
  const waitByPart = new Map();
  const deadAt = new Map(); // tool part id -> when the process that prompted for it went away
  for (const p of prompts) {
    if (p.part && p.abandonedAt != null) deadAt.set(p.part.id, p.abandonedAt);
    const b = ctx.bucket(p.t);
    if (b) {
      b.prompts++;
      b.waitMs += p.waitMs;
    }
    if (p.part) waitByPart.set(p.part.id, (waitByPart.get(p.part.id) ?? 0) + (p.answeredAt ? p.waitMs : 0));
  }
  return { prompts, all, waitByPart, deadAt };
}

/**
 * How long a call ran once it was allowed to. null for one still unknown; "left" for one
 * abandoned by a crash or abort, where the time it "ran" says nothing about the command.
 */
function runOf(p, t, ctx, { movedOn, deadAt, waitByPart }) {
  // A call with no end either still runs, or was left behind when its session moved on.
  const unfinished = p.ended == null && (p.status === 'running' || p.status === 'pending');
  const leftAt = unfinished ? (movedOn(p.session_id, t) ?? deadAt.get(p.id) ?? null) : null;
  if (leftAt != null) return { unfinished, left: true, runMs: null };
  const end = p.ended ?? (unfinished ? ctx.now : null);
  return { unfinished, left: false, runMs: end == null ? null : Math.max(0, end - t - (waitByPart.get(p.id) ?? 0)) };
}

/** Tool calls: counts, errors, and how long each ran. */
function tallyTools(ctx, tools, timing, stuckMs) {
  const perTool = new Map();
  const slow = [];
  const reads = new Map(); // session|file -> count
  const skills = new Map();
  const explore = { graft: 0, other: 0 };
  const calls = []; // every call counted below, for the per-server figures
  const perRoot = new Map(); // top-level session id -> { toolCalls, lastAt }, whatever the filter
  const { rootOf } = ctx;
  for (const p of tools) {
    const t = startOf(p);
    const b = ctx.bucket(t);
    if (!b) continue;
    const rootId = rootOf(p.session_id);
    const root = perRoot.get(rootId) ?? { toolCalls: 0, lastAt: 0 };
    root.toolCalls++;
    root.lastAt = Math.max(root.lastAt, t);
    perRoot.set(rootId, root);
    if (!ctx.inScope(p.session_id)) continue;

    b.toolCalls++;
    const entry = perTool.get(p.tool) ?? { tool: p.tool, count: 0, errors: 0, totalMs: 0 };
    entry.count++;
    if (p.status === 'error') {
      entry.errors++;
      b.toolErrors++;
    }
    const { unfinished, left, runMs } = runOf(p, t, ctx, timing);
    if (left) b.abandoned++;
    if (runMs != null) {
      entry.totalMs += runMs;
      if (runMs > stuckMs) b.stuck++;
      slow.push({ p, runMs, running: unfinished });
    }
    perTool.set(p.tool, entry);
    calls.push({ tool: p.tool, status: p.status, error: p.error, session_id: p.session_id, at: t, runMs: unfinished ? null : runMs });
    if (isGraft(p.tool)) explore.graft++;
    else if (isExploreTool(p.tool)) explore.other++;
    if (p.tool === 'read' && p.file) reads.set(`${p.session_id}|${p.file}`, (reads.get(`${p.session_id}|${p.file}`) ?? 0) + 1);
    if (p.tool === 'skill' && p.skill) skills.set(p.skill, (skills.get(p.skill) ?? 0) + 1);
  }
  return { perTool, slow, reads, skills, explore, calls, perRoot };
}

const EMPTY_EFFORT = Object.freeze({ activeMs: 0, waitMs: 0, compactions: 0, tokens: 0, cost: 0 });

/**
 * What each top-level session cost in the range, subagents included, whatever the filter:
 * the list is for choosing which session to look at.
 */
function effortPerSession(ctx, { messages, compactions, prompts }) {
  const effort = new Map();
  const bump = (id, key, n) => {
    const root = ctx.rootOf(id);
    const e = effort.get(root) ?? { ...EMPTY_EFFORT };
    e[key] += n;
    effort.set(root, e);
  };
  for (const m of messages) {
    if (m.role !== 'assistant' || m.time_created < ctx.from || m.time_created > ctx.now) continue;
    const end = Math.min(m.completed ?? m.time_created, ctx.now);
    if (end > m.time_created) bump(m.session_id, 'activeMs', end - m.time_created);
    const tokens = tokensSent(m) + (m.tokens_output ?? 0);
    if (tokens > 0) bump(m.session_id, 'tokens', tokens);
    if (m.cost > 0) bump(m.session_id, 'cost', m.cost);
  }
  for (const c of compactions) if (c.time_created >= ctx.from) bump(c.session_id, 'compactions', 1);
  for (const p of prompts) if (p.part) bump(p.part.session_id, 'waitMs', p.waitMs);
  return effort;
}

/**
 * @param {object} input
 * @param {object[]} input.sessions   id, title, directory, parent_id, time_created, time_updated
 * @param {object[]} input.tools      tool parts started in the range
 * @param {object[]} input.messages   id, session_id, role, time_created, completed, model, tokens
 * @param {Map<string, {first_token: number|null, written: number|null}>} [input.steps]
 *   per message id: when its first token arrived and when the model stopped writing
 * @param {object[]} input.compactions session_id, time_created
 * @param {object[]} input.asks       prompts from the log, in the range
 * @param {Map<string, number>} input.replies question id -> answer time
 * @param {Map<string, number[]>} input.eventTimes tool part id -> update times, ascending
 * @param {(text: string) => string} input.show redact and shorten for display
 * @param {string|null} [input.sessionId] count only this session and its subagents
 * @param {(provider: string, model: string) => number|null} [input.contextLimit]
 * @param {{servers: object[], events: object[], logFrom: number|null}|null} [input.mcp]
 *   MCP servers known for these sessions, and the marked failure lines from the log
 */
export function computeStats({ sessions, tools, messages, compactions, asks, replies, eventTimes, now, days, stuckMs, show, liveRuns = null, runEnds = new Map(), sessionId = null, mcp = null, steps = new Map(), contextLimit = () => null, compactAt = () => null }) {
  const keys = dayRange(now, days);
  const from = new Date(`${keys[0]}T00:00:00`).getTime();
  const daily = new Map(keys.map(k => [k, { date: k, activeMs: 0, waitMs: 0, prompts: 0, stuck: 0, abandoned: 0, toolCalls: 0, toolErrors: 0, compactions: 0, sessions: 0, tokens: 0, cost: 0 }]));
  const bucket = t => daily.get(dayKey(t));
  const sessionById = new Map(sessions.map(s => [s.id, s]));
  const scope = sessionId ? withDescendants(sessions, sessionId) : null;
  const inScope = id => !scope || scope.has(id);
  // The top-level session a session belongs to: subagent work counts for its parent.
  const rootOf = id => {
    let s = sessionById.get(id);
    for (let depth = 0; s?.parent_id && sessionById.has(s.parent_id) && depth < 20; depth++) s = sessionById.get(s.parent_id);
    return s?.id ?? id;
  };
  const ctx = { from, now, bucket, inScope, sessionById, sessionId, rootOf };
  const where = id => {
    const s = sessionById.get(id);
    const directory = s?.directory ?? '';
    return { project: show(directory.split(/[\\/]/).filter(Boolean).pop() ?? '', 80), title: show(s?.title ?? '', 120) };
  };

  for (const s of sessions) if (inScope(s.id) && s.time_created >= from && !s.parent_id) bucket(s.time_created) && bucket(s.time_created).sessions++;
  for (const c of compactions) if (inScope(c.session_id)) bucket(c.time_created) && bucket(c.time_created).compactions++;

  const { usage, startSizes, timed, own } = tallyRequests(ctx, messages, steps);
  const movedOn = nextMessageFinder(messages);
  const { prompts, all: allPrompts, waitByPart, deadAt } = tallyPrompts(ctx, { asks, replies, tools, eventTimes, movedOn, liveRuns, runEnds, scope });
  const { perTool, slow, reads, skills, explore, calls, perRoot } = tallyTools(ctx, tools, { movedOn, deadAt, waitByPart }, stuckMs);

  const sum = key => [...daily.values()].reduce((n, d) => n + d[key], 0);
  const answered = prompts.filter(p => p.answeredAt != null);
  const totals = {
    sessions: sum('sessions'),
    activeMs: sum('activeMs'),
    waitMs: sum('waitMs'),
    prompts: prompts.length,
    open: prompts.filter(p => p.answeredAt == null && !p.abandoned).length,
    abandoned: prompts.filter(p => p.abandoned).length,
    medianAnswerMs: median(answered.map(p => p.waitMs)),
    stuck: sum('stuck'),
    abandonedCalls: sum('abandoned'),
    toolCalls: sum('toolCalls'),
    toolErrors: sum('toolErrors'),
    compactions: sum('compactions'),
    // Compactions OpenCode did because the model server refused a request as too long.
    serverLimitCompactions: compactions.filter(c => c.overflow && c.time_created >= from && inScope(c.session_id)).length,
    // Files read three or more times within one session.
    rereads: [...reads.values()].filter(n => n >= 3).length,
  };
  const sentTotal = usage.input + usage.cacheRead + usage.cacheWrite;

  const effort = effortPerSession(ctx, { messages, compactions, prompts: allPrompts });

  const describe = p => p.cmd ?? p.file ?? p.question ?? p.descr ?? '';
  return {
    range: { from, to: now, days },
    session: sessionId ? { id: sessionId, ...where(sessionId) } : null,
    // What can be filtered on: top-level sessions with tool calls in the range, newest first.
    sessions: [...perRoot]
      .sort((a, b) => b[1].lastAt - a[1].lastAt)
      .slice(0, MAX_SESSIONS_LISTED)
      .map(([id, use]) => {
        const e = effort.get(id) ?? EMPTY_EFFORT;
        return { id, ...where(id), toolCalls: use.toolCalls, lastAt: use.lastAt, ...e, cost: Math.round(e.cost * 10_000) / 10_000 };
      }),
    // The log does not say which session a server failed in, so with a session filter the
    // failure counts are left out rather than shown for the wrong session.
    mcp: mcp ? computeMcpStats({ servers: mcp.servers, calls, events: scope ? null : mcp.events, from, now }) : [],
    mcpLogFrom: mcp?.logFrom ?? null,
    // Only for one session: a context window belongs to a session, not to a period.
    context: sessionId
      ? contextTimeline({
          requests: own,
          compactions: compactions.filter(c => c.session_id === sessionId && c.time_created >= from).map(c => c.time_created).sort((a, b) => a - b),
          reads: tools.filter(p => p.session_id === sessionId && p.tool === 'read' && p.file && p.status === 'completed').map(p => ({ t: startOf(p), file: p.file })).sort((a, b) => a.t - b.t),
          limit: own.length ? contextLimit(own.at(-1).provider, own.at(-1).model) : null,
          compactAt: own.length ? compactAt(own.at(-1).provider, own.at(-1).model, sessionById.get(sessionId)?.directory) : null,
        })
      : null,
    speed: computeSpeed({ requests: timed, keys, show }),
    usage: {
      ...usage,
      // Share of what was sent that the model server could reuse from its cache.
      cachedPct: sentTotal ? Math.round((usage.cacheRead / sentTotal) * 100) : null,
      start: startSizes.length ? { median: median(startSizes), min: Math.min(...startSizes), max: Math.max(...startSizes), sessions: startSizes.length } : null,
    },
    stuckMs,
    daily: [...daily.values()].map(d => ({ ...d, cost: Math.round(d.cost * 10_000) / 10_000 })),
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
    explore,
    rereads: [...reads]
      .filter(([, n]) => n >= 3)
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_REREADS)
      .map(([key, count]) => {
        const [sessionId, file] = key.split('|');
        return { file: show(file, 200), count, ...where(sessionId) };
      }),
    skills: [...skills].sort((a, b) => b[1] - a[1]).slice(0, TOP).map(([name, count]) => ({ name: show(name, 80), count })),
  };
}
