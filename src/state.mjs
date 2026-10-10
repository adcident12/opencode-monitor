// Pure logic: turns rows from the database and log into a state and health figures.
// No I/O here, so every rule can be unit-tested.

// Most urgent first.
export const STATES = ['waiting', 'stuck', 'error', 'working', 'finished', 'idle'];

// A permission prompt is logged within a couple of milliseconds of the tool part's last
// update. OpenCode does not record the answer, so "still pending" means: the part is still
// running and has not been touched since the prompt.
const ASK_MATCH_MS = 2000;

const minutes = n => n * 60_000;
const isRunningTool = p => p.type === 'tool' && (p.status === 'running' || p.status === 'pending');
const startOf = p => p.started ?? p.time_created;

function findAsk(asks, at) {
  for (let i = asks.length - 1; i >= 0; i--) {
    const ask = asks[i];
    if (ask.kind === 'permission' && Math.abs(ask.t - at) <= ASK_MATCH_MS) return ask;
    if (ask.t < at - ASK_MATCH_MS) break;
  }
  return null;
}

/**
 * @param {object} input
 * @param {object} input.session   session row
 * @param {object[]} input.parts   all parts of the session, oldest first
 * @param {object[]} input.messages last few messages, oldest first
 * @param {object[]} input.asks    prompts seen in the log, oldest first
 * @param {number} input.now
 * @param {object} input.thresholds
 * @param {boolean|null} input.opencodeRunning null = unknown, treated as running
 */
export function deriveState({ session, parts, messages, asks, now, thresholds, opencodeRunning }) {
  const result = live({ session, parts, messages, asks, now, thresholds });
  // Nothing can be working, waiting, or stuck if OpenCode itself is gone.
  if (opencodeRunning === false && ['working', 'waiting', 'stuck'].includes(result.state)) {
    return { state: 'idle', reason: 'not_running', since: result.since, current: result.current ?? null };
  }
  return result;
}

function live({ session, parts, messages, asks, now, thresholds }) {
  const last = messages.at(-1);
  if (!last) return { state: 'idle', reason: 'empty', since: session.time_created };

  let lastActivity = Math.max(last.time_created, last.completed ?? 0);
  for (const p of parts) if (p.time_updated > lastActivity) lastActivity = p.time_updated;
  const turnStart = messages.findLast(m => m.role === 'user')?.time_created ?? messages[0].time_created;

  if (last.role === 'assistant' && last.error) {
    return last.error === 'MessageAbortedError'
      ? { state: 'idle', reason: 'aborted', since: lastActivity }
      : { state: 'error', reason: 'message_error', detail: last.error, since: lastActivity };
  }

  // Running tools on older messages are leftovers from a crash or abort, not live work.
  const running = last.role === 'assistant' ? parts.filter(p => p.message_id === last.id && isRunningTool(p)) : [];

  const question = running.find(p => p.tool === 'question');
  if (question) {
    return {
      state: 'waiting', reason: 'question', since: startOf(question), current: question,
      prompt: { kind: 'question', permission: null, detail: question.question ?? '' },
    };
  }
  for (const p of running) {
    const ask = findAsk(asks, p.time_updated);
    if (ask) {
      return {
        state: 'waiting', reason: 'permission', since: ask.t, current: p,
        prompt: { kind: 'permission', permission: ask.permission, detail: ask.patterns },
      };
    }
  }

  if (running.length) {
    const oldest = running.reduce((a, b) => (startOf(b) < startOf(a) ? b : a));
    const limitMs = minutes(thresholds.stuckToolMinutesByTool?.[oldest.tool] ?? thresholds.stuckToolMinutes);
    return now - startOf(oldest) > limitMs
      ? { state: 'stuck', reason: 'tool_long', since: startOf(oldest), current: oldest, limitMs }
      : { state: 'working', reason: 'tool', since: turnStart, current: oldest };
  }

  if (session.time_compacting) return { state: 'working', reason: 'compacting', since: session.time_compacting };

  if (last.role === 'assistant' && last.completed) {
    if (last.finish === 'stop') return { state: 'finished', reason: 'done', since: last.completed };
    if (last.finish === 'length') return { state: 'error', reason: 'length', since: last.completed };
    if (last.finish !== 'tool-calls') return { state: 'idle', reason: 'unknown_finish', since: last.completed };
  }

  // The model owes the next output. Slow local models can be quiet for minutes, hence a threshold.
  const limitMs = minutes(thresholds.silentMinutes);
  if (now - lastActivity > limitMs) return { state: 'stuck', reason: 'silent', since: lastActivity, limitMs };
  const reason = last.role === 'user' ? 'thinking' : last.completed ? 'between_steps' : 'generating';
  return { state: 'working', reason, since: turnStart };
}

// Short text describing what a tool call is doing. Raw: redact before showing.
export function describePart(p) {
  if (!p) return '';
  return p.cmd ?? p.file ?? p.question ?? p.descr ?? p.input ?? '';
}

/**
 * How far the current turn has got: when anything last happened, the latest tool calls,
 * and the agent's own task list. OpenCode stores a running command's output as it arrives,
 * so a command's `time_updated` is the time of its last output. Model replies are stored
 * only when they start and when they end, so there is no partial text to show for those.
 */
export function deriveProgress({ parts, messages, todos = [], maxSteps = 6 }) {
  const last = messages.at(-1);
  let lastActivityAt = last ? Math.max(last.time_created, last.completed ?? 0) : null;
  for (const p of parts) if (p.time_updated > lastActivityAt) lastActivityAt = p.time_updated;

  const turnStart = messages.findLast(m => m.role === 'user')?.time_created ?? 0;
  const steps = [];
  for (let i = parts.length - 1; i >= 0 && steps.length < maxSteps; i--) {
    const p = parts[i];
    if (p.time_created < turnStart) break;
    if (p.type !== 'tool') continue;
    steps.unshift({
      tool: p.tool,
      text: describePart(p),
      status: p.status,
      startedAt: startOf(p),
      durationMs: p.ended != null && p.started != null ? p.ended - p.started : null,
    });
  }

  const done = todos.filter(t => t.status === 'completed').length;
  const open = todos.filter(t => t.status !== 'cancelled');
  return {
    lastActivityAt,
    steps,
    todos: open.length
      ? { done, total: open.length, current: todos.find(t => t.status === 'in_progress')?.content ?? null }
      : null,
  };
}

// How many recent requests set the pace of growth.
const GROWTH_WINDOW = 8;

/**
 * Typical growth per request: the median increase between consecutive requests since the
 * last compaction. A median, so one huge file read does not make every request look huge.
 */
function growthOf(sizes) {
  const steps = [];
  for (let i = Math.max(1, sizes.length - GROWTH_WINDOW); i < sizes.length; i++) if (sizes[i] > sizes[i - 1]) steps.push(sizes[i] - sizes[i - 1]);
  if (steps.length < 2) return null;
  steps.sort((a, b) => a - b);
  return steps[Math.floor(steps.length / 2)];
}

/**
 * @param {number|null} [compactAt] context size at which OpenCode compacts (compactionPoint)
 */
export function deriveHealth({ session, parts, now, thresholds, contextLimit, compactAt = null, autoCompact = true }) {
  let contextTokens = null;
  let sizes = []; // what each request counted against compaction, since the last compaction
  let compacting = false; // compacted, and no ordinary request has run since
  let overflowCompactions = 0; // compactions forced by the model server refusing the request
  let compactions = 0;
  let toolCalls = 0;
  let toolErrors = 0;
  let lastError = null;
  const recentTools = [];

  for (const p of parts) {
    if (p.type === 'step-finish') {
      const sent = (p.tokens_input ?? 0) + (p.tokens_cache_read ?? 0) + (p.tokens_cache_write ?? 0);
      // The summary that a compaction writes still sends the whole old context, so it says
      // nothing about the new one. OpenCode marks its message as a summary.
      if (p.msg_summary) continue;
      compacting = false;
      contextTokens = sent;
      // What OpenCode compares with the compaction point: the request's total.
      if (sent > 0) sizes.push(p.tokens_total || sent + (p.tokens_output ?? 0));
    } else if (p.type === 'compaction') {
      compactions++;
      if (p.overflow) overflowCompactions++;
      sizes = [];
      compacting = true;
    } else if (p.type === 'tool') {
      toolCalls++;
      if (p.status === 'error') {
        toolErrors++;
        lastError = { tool: p.tool, text: p.error ?? '', at: p.time_updated };
      }
      recentTools.push(p);
      if (recentTools.length > thresholds.repeatWindow) recentTools.shift();
    }
  }

  // The same tool with the same input several times in a short window usually means a loop.
  let repeat = null;
  const seen = new Map();
  for (const p of recentTools) {
    const key = `${p.tool}|${p.input_len}|${p.input ?? ''}`;
    const entry = seen.get(key) ?? { count: 0, part: p };
    entry.count++;
    seen.set(key, entry);
    if (entry.count >= thresholds.repeatWarn && (!repeat || entry.count > repeat.count)) repeat = entry;
  }

  // While compacting, the last known size is the old context: not shown as if it were current.
  if (compacting) contextTokens = null;
  const contextPct = contextTokens != null && contextLimit ? Math.round((contextTokens / contextLimit) * 100) : null;
  const ageMs = now - session.time_created;

  // Room left before OpenCode compacts, and roughly how many requests of the usual size fit.
  const used = sizes.at(-1) ?? null;
  const growth = growthOf(sizes);
  const room = compactAt && used != null ? Math.max(0, compactAt - used) : null;
  const compaction = room == null ? null : { at: compactAt, room, growth, requestsLeft: growth ? Math.floor(room / growth) : null };
  const soon = compaction != null && (used >= compactAt * (thresholds.compactWarnPct / 100) || (compaction.requestsLeft != null && compaction.requestsLeft <= thresholds.compactWarnRequests));

  const hints = [];
  // With a known compaction point, warn against it; otherwise fall back to the window size.
  if (compaction ? soon : contextPct != null && contextPct >= thresholds.contextWarnPct) hints.push('context_high');
  if (compactions >= thresholds.compactionWarn) hints.push('many_compactions');
  if (ageMs >= thresholds.sessionAgeWarnHours * 3_600_000) hints.push('old_session');
  if (repeat) hints.push('looping');
  // The model server turned a request away before OpenCode's own limit was reached: its
  // context size is smaller than limit.context in opencode.json.
  if (overflowCompactions) hints.push('server_limit');
  if (toolErrors >= thresholds.toolErrorWarn) hints.push('many_errors');

  return {
    contextTokens, contextLimit: contextLimit ?? null, contextPct, compaction, compacting, overflowCompactions, autoCompact,
    compactions, toolCalls, toolErrors, lastError,
    repeat: repeat ? { count: repeat.count, tool: repeat.part.tool, text: describePart(repeat.part) } : null,
    hints,
    suggestNewSession: hints.some(h => h === 'context_high' || h === 'many_compactions' || h === 'old_session'),
  };
}

// A parent running the `task` tool is only as healthy as its subagent session: a permission
// prompt inside a subagent blocks the parent too.
export function bubbleChildren(sessions) {
  const byParent = new Map();
  for (const s of sessions) {
    if (!s.parentId) continue;
    if (!byParent.has(s.parentId)) byParent.set(s.parentId, []);
    byParent.get(s.parentId).push(s);
  }
  for (const parent of sessions) {
    const children = byParent.get(parent.id);
    if (!children || parent.current?.tool !== 'task') continue;
    if (parent.state !== 'working' && parent.state !== 'stuck') continue;
    const waiting = children.find(c => c.state === 'waiting');
    const stuck = children.find(c => c.state === 'stuck');
    const working = children.find(c => c.state === 'working');
    if (waiting) {
      Object.assign(parent, { state: 'waiting', reason: 'child_waiting', since: waiting.since, prompt: waiting.prompt, viaChild: waiting.id });
    } else if (stuck) {
      Object.assign(parent, { state: 'stuck', reason: 'child_stuck', since: stuck.since, viaChild: stuck.id });
    } else if (working && parent.state === 'stuck') {
      Object.assign(parent, { state: 'working', reason: 'subagent', viaChild: working.id });
    }
  }
  return sessions;
}
