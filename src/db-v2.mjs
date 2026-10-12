// OpenCode 2 keeps a session's messages in one table, a row a message with the whole message
// as JSON (session_message), where 1.x had a row a message and a row a part. These functions
// turn those rows into the rows the 1.x queries in db.mjs return, so nothing past db.mjs
// needs to know which version wrote a session. Pure: rows in, rows out.
import { toolPrefix } from './mcp.mjs';

// Tools that were renamed. The rest of the monitor knows them by their 1.x names.
const RENAMED = { shell: 'bash', subagent: 'task' };
// The same lengths db.mjs cuts the 1.x columns to.
const OUTPUT_TAIL_CHARS = 1500;
const OUTPUT_SCAN_CHARS = 8000;

const text = (value, max) => (typeof value === 'string' ? value.slice(0, max) : null);
const num = value => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/** What 1.x called the error a reply ended with; an abort keeps its 1.x name. */
function errorName(error) {
  if (!error || typeof error !== 'object') return null;
  if (error.type === 'aborted' || error.name === 'MessageAbortedError') return 'MessageAbortedError';
  return text(error.name, 200) ?? text(error.type, 200) ?? 'Error';
}

/**
 * The MCP calls an `execute` script made. OpenCode 2 runs every MCP tool from a script given
 * to its `execute` tool ("Code Mode"), and lists on the call the tools the script reached.
 * Only that list is believed. The script's text says what it meant to call, not what it did:
 * one stopped before its first call names a tool that was never run. A script without a list
 * (still running, or interrupted) is one `execute` call, with no MCP call claimed for it.
 */
export function mcpCallsOf(state) {
  const listed = state?.metadata?.toolCalls;
  if (!Array.isArray(listed)) return [];
  return listed
    .filter(c => typeof c?.tool === 'string' && c.tool.includes('.'))
    .map(c => {
      const dot = c.tool.indexOf('.');
      return { server: c.tool.slice(0, dot), tool: c.tool.slice(dot + 1), status: typeof c.status === 'string' ? c.status : null, input: c.input && typeof c.input === 'object' ? c.input : null };
    });
}

/** A tool's output as text: what it returned, or what a running command has printed so far. */
function outputOf(state) {
  if (typeof state?.metadata?.output === 'string') return state.metadata.output;
  if (!Array.isArray(state?.content)) return '';
  return state.content.filter(c => typeof c?.text === 'string').map(c => c.text).join('\n');
}

/** One tool call as a 1.x tool part, with every column db.mjs reads from one. */
function toolRow(row, item) {
  const state = item.state ?? {};
  const input = state.input && typeof state.input === 'object' ? state.input : {};
  const status = typeof state.status === 'string' ? state.status : null;
  const running = status === 'running' || status === 'pending';
  const time = item.time ?? {};
  const output = outputOf(state);
  const inputJson = JSON.stringify(input);
  const error = state.error;
  return {
    id: String(item.id ?? `${row.id}:${time.created}`),
    message_id: row.id,
    session_id: row.session_id,
    type: 'tool',
    // Written by OpenCode 2: what it is waiting for is asked of OpenCode, not read from the log.
    v2: true,
    time_created: num(time.created) ?? row.time_created,
    // A call still running was last updated when its message was; a finished one when it ended.
    time_updated: running ? row.time_updated : (num(time.completed) ?? row.time_updated),
    tool: RENAMED[item.name] ?? String(item.name ?? ''),
    status,
    // Rows OpenCode 2 copied from 1.x have no "ran": their "created" is when the call started.
    started: num(time.ran) ?? (running ? null : num(time.created)),
    ended: running ? null : num(time.completed),
    cmd: text(input.command, 4000),
    // OpenCode 2's shell runs a command in the background when asked, with no `&` in it.
    background: input.background === true,
    file: text(input.path, 1000) ?? text(input.filePath, 1000),
    question: text(input.questions?.[0]?.question, 1000),
    descr: text(input.description, 1000),
    url: text(input.url, 500),
    skill: text(input.id, 100) ?? text(input.name, 100),
    scan_out: output.slice(0, OUTPUT_SCAN_CHARS) || null,
    input: inputJson.slice(0, 1000),
    input_len: inputJson.length,
    error: text(typeof error === 'string' ? error : error?.message, 500),
    out_len: output.length || null,
    out_tail: running ? output.slice(-OUTPUT_TAIL_CHARS) : null,
    todos: item.name === 'todowrite' && Array.isArray(input.todos) ? JSON.stringify(input.todos) : null,
  };
}

/**
 * The rows one tool call counts as. An `execute` script that called MCP tools counts as those
 * calls, named as 1.x named them (server_tool), sharing the script's running time; one that
 * only searched the tool catalog stays one `execute` call.
 */
export function toolRowsOf(row, item) {
  const base = toolRow(row, item);
  if (item.name !== 'execute') return [base];
  const calls = mcpCallsOf(item.state);
  if (!calls.length) return [base];
  const { started, ended } = base;
  const share = started != null && ended != null ? (ended - started) / calls.length : null;
  return calls.map((call, i) => {
    // What this call was given, so that two different calls of one script are not taken for
    // the same call made twice. Unknown when only the script is: then its place in the script.
    const input = call.input ? JSON.stringify(call.input) : `${base.input}#${i}`;
    return {
      ...base,
      id: `${base.id}:${i}`,
      tool: toolPrefix(call.server) + call.tool,
      status: base.status === 'running' || base.status === 'pending' ? base.status : (call.status ?? base.status),
      started: share == null ? started : Math.round(started + i * share),
      ended: share == null ? ended : Math.round(started + (i + 1) * share),
      url: text(call.input?.url, 500),
      input: input.slice(0, 1000),
      input_len: input.length,
    };
  });
}

const tokensOf = d => ({
  tokens_input: num(d.tokens?.input),
  tokens_output: num(d.tokens?.output),
  tokens_reasoning: num(d.tokens?.reasoning),
  tokens_cache_read: num(d.tokens?.cache?.read),
  tokens_cache_write: num(d.tokens?.cache?.write),
});

const EMPTY_MESSAGE = {
  completed: null, summary: null, finish: null, error_name: null, error: null, agent: null,
  provider_id: null, model_id: null, tokens_input: null, tokens_output: null, tokens_reasoning: null,
  tokens_cache_read: null, tokens_cache_write: null, cost: null,
};

function parse(row) {
  try {
    const data = JSON.parse(row.data);
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
}

/**
 * Every row the 1.x queries give for these OpenCode 2 messages.
 * @param {object[]} rows  session_message rows (id, session_id, type, time_created,
 *   time_updated, data), in order: by session, then time_created, then seq
 * @returns {{messages, tools, spans, steps, compactions, patches, todoWrites, parts}}
 *   parts: the live view's rows (tool, step-start, step-finish, patch, compaction)
 */
export function normalizeV2(rows) {
  const out = { messages: [], tools: [], spans: [], steps: [], compactions: [], patches: [], todoWrites: [], parts: [] };
  const lastReply = new Map(); // session id -> its latest assistant message so far
  const summarizing = new Map(); // session id -> the compaction whose end is not yet bounded
  for (const row of rows) {
    const d = parse(row);
    if (!d) continue;
    // A compaction was over by the time the session's next row was written, whatever its own
    // row says: a row's update time can be later than the work (a copy, a later edit).
    const pending = summarizing.get(row.session_id);
    if (pending) {
      if (pending.completed != null) pending.completed = Math.min(pending.completed, row.time_created);
      summarizing.delete(row.session_id);
    }
    const base = { ...EMPTY_MESSAGE, id: row.id, session_id: row.session_id, time_created: row.time_created };
    if (row.type === 'user') out.messages.push({ ...base, role: 'user' });
    else if (row.type === 'synthetic') out.messages.push({ ...base, role: 'user', synthetic: true });
    else if (row.type === 'assistant') lastReply.set(row.session_id, assistant(out, row, d, base));
    else if (row.type === 'compaction') summarizing.set(row.session_id, compaction(out, row, d, base));
    else if (row.type === 'idle' && d.outcome === 'interrupted') {
      // Stopped by you: 1.x marked the reply itself as aborted.
      const reply = lastReply.get(row.session_id);
      if (reply && !reply.error_name) reply.error_name = reply.error = 'MessageAbortedError';
    }
  }
  return out;
}

const lengthOf = value => (typeof value === 'string' ? value.length : 0);

/**
 * Thinking and writing in a reply OpenCode 2 wrote. It times the reasoning from its first
 * token to the end of the whole reply, and does not time the text or the tool calls written
 * after it. So the time is shared out by length: the reasoning's part of everything the model
 * wrote is thinking, the rest is writing (counted, as in 1.x, only when the reply has text).
 * An estimate: on 1.x data, where both were timed, it gives 106% of the thinking and 95% of
 * the writing over 9,439 replies. Nothing is said for a reply without reasoning.
 */
export function estimatedSpans(content, streamed) {
  const thoughts = content.filter(i => i?.type === 'reasoning' && num(i.time?.created) != null);
  if (!thoughts.length) return [];
  const start = Math.min(...thoughts.map(i => i.time.created));
  if (!(streamed > start)) return [];
  const thought = thoughts.reduce((n, i) => n + lengthOf(i.text), 0);
  const texts = content.filter(i => i?.type === 'text');
  const rest = texts.reduce((n, i) => n + lengthOf(i.text), 0)
    + content.filter(i => i?.type === 'tool').reduce((n, i) => n + JSON.stringify(i.state?.input ?? {}).length, 0);
  const turn = thought + rest ? Math.round(start + ((streamed - start) * thought) / (thought + rest)) : streamed;
  const spans = [{ type: 'reasoning', s: start, e: turn }];
  if (texts.length && streamed > turn) spans.push({ type: 'text', s: turn, e: streamed });
  return spans;
}

/**
 * The same for a reply OpenCode 2 copied from 1.x, which kept the reasoning's own end: the
 * text ran from there to the end of the reply (the recorded time for the typical reply: median
 * ratio 1.000 over 5,694 replies of 1.x data).
 */
function copiedSpans(content, written) {
  const spans = [];
  let thoughtUntil = null;
  let hasText = false;
  for (const item of content) {
    if (item?.type === 'text') hasText = true;
    if (item?.type !== 'reasoning') continue;
    const e = num(item.time?.completed);
    spans.push({ type: 'reasoning', s: num(item.time?.created), e });
    if (!hasText && e != null) thoughtUntil = Math.max(thoughtUntil ?? 0, e);
  }
  if (hasText && thoughtUntil != null && written != null && written > thoughtUntil) spans.push({ type: 'text', s: thoughtUntil, e: written });
  return spans;
}

function assistant(out, row, d, base) {
  const time = d.time ?? {};
  const content = Array.isArray(d.content) ? d.content : [];
  const message = {
    ...base,
    role: 'assistant',
    completed: num(time.completed),
    finish: text(d.finish, 40),
    error_name: errorName(d.error),
    agent: text(d.agent, 80),
    provider_id: text(d.model?.providerID, 200),
    model_id: text(d.model?.id, 200),
    ...tokensOf(d),
    cost: num(d.cost),
  };
  message.error = message.error_name;
  // A compaction summary written as a reply, as 1.x did it.
  if (message.agent === 'compaction') message.summary = true;
  out.messages.push(message);
  out.parts.push({ id: `${row.id}:start`, message_id: row.id, session_id: row.session_id, type: 'step-start', time_created: row.time_created, time_updated: row.time_updated });

  // The first token is the start of the first thing written. OpenCode 2 does not time text, so
  // a reply that opens with text has no known first token: left out rather than guessed late.
  const firstToken = num(content[0]?.time?.created);
  let lastWritten = null;
  const later = (a, b) => (b == null ? a : a == null ? b : Math.max(a, b));
  for (const item of content) {
    const t = item?.time ?? {};
    if (item?.type === 'reasoning') lastWritten = later(lastWritten, num(t.completed));
    if (item?.type !== 'tool') continue;
    lastWritten = later(lastWritten, num(t.ran) ?? num(t.created));
    for (const tool of toolRowsOf(row, item)) {
      out.tools.push(tool);
      out.parts.push(tool);
      if (tool.tool === 'todowrite' && tool.status === 'completed' && tool.todos) out.todoWrites.push({ session_id: row.session_id, time_created: tool.time_created, todos: tool.todos });
    }
  }
  // When the model stopped writing: OpenCode 2 records it; otherwise the last thing written.
  const streamed = num(time.streamed);
  const written = streamed ?? lastWritten;
  out.steps.push({ message_id: row.id, first_token: firstToken, written });
  for (const span of streamed == null ? copiedSpans(content, written) : estimatedSpans(content, streamed)) out.spans.push({ session_id: row.session_id, ...span });

  const files = Array.isArray(d.snapshot?.files) ? d.snapshot.files.filter(f => typeof f === 'string') : [];
  if (files.length) {
    const at = num(time.completed) ?? row.time_updated;
    out.patches.push({ session_id: row.session_id, time_created: at, files: JSON.stringify(files) });
    out.parts.push({ id: `${row.id}:patch`, message_id: row.id, session_id: row.session_id, type: 'patch', time_created: at, time_updated: row.time_updated, files: JSON.stringify(files) });
  }
  if (d.tokens) {
    const n = message;
    out.parts.push({
      id: `${row.id}:finish`, message_id: row.id, session_id: row.session_id, type: 'step-finish',
      time_created: num(time.completed) ?? row.time_updated, time_updated: row.time_updated,
      tokens_input: n.tokens_input, tokens_output: n.tokens_output, tokens_cache_read: n.tokens_cache_read, tokens_cache_write: n.tokens_cache_write,
      tokens_total: (n.tokens_input ?? 0) + (n.tokens_output ?? 0) + (n.tokens_reasoning ?? 0) + (n.tokens_cache_read ?? 0) + (n.tokens_cache_write ?? 0),
      msg_summary: n.summary,
    });
  }
  return message;
}

/**
 * A compaction is a row of its own in OpenCode 2. 1.x had a reply by the compaction agent
 * for it, and the figures count its time as agent time, so it becomes one of those too.
 */
function compaction(out, row, d, base) {
  const auto = d.reason === 'auto' ? 1 : 0;
  const overflow = d.reason === 'overflow' || d.overflow === true ? 1 : 0;
  out.compactions.push({ session_id: row.session_id, time_created: row.time_created, auto, overflow });
  const done = d.status === 'completed';
  const message = {
    ...base,
    role: 'assistant',
    agent: 'compaction',
    summary: true,
    completed: done ? row.time_updated : null,
    finish: done ? 'stop' : null,
    // Still summarising: OpenCode 2 does not set the session's time_compacting, as 1.x did.
    // Only a status that says so: one that failed, or is not known, is not taken for work.
    compacting: d.status === 'running' || d.status === 'pending',
    // A row of its own: 1.x wrote a user message before each compaction, OpenCode 2 does not,
    // so a prompt of yours just before one is yours.
    standalone: true,
    // What the summary cost, which OpenCode 2 writes on the row once it is done.
    provider_id: text(d.model?.providerID, 200),
    model_id: text(d.model?.id, 200),
    ...tokensOf(d),
    cost: num(d.cost),
  };
  out.messages.push(message);
  out.parts.push({ id: row.id, message_id: row.id, session_id: row.session_id, type: 'compaction', time_created: row.time_created, time_updated: row.time_updated, auto, overflow });
  return message;
}
