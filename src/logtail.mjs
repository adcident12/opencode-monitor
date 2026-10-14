// Follows OpenCode's log file for two things the database does not record:
// permission/question prompts, and MCP servers failing.
import { openSync, readSync, closeSync, fstatSync } from 'node:fs';
import { latestFailures, markShutdowns } from './mcp.mjs';

const MAX_INITIAL_BYTES = 64 * 1024 * 1024;
const MAX_ASKS = 5000;
const MAX_MCP_EVENTS = 5000;

// Anchored to the fixed prefix so text inside a logged command cannot pose as an event.
const PREFIX = /^timestamp=(\S+) level=\S+ run=(\S+) /;
const ASK = /^timestamp=(\S+) level=\S+ run=(\S+) message=asking id=((per|que)_\S+)(?: permission=(\S+))?(?: patterns=(.*))?/;
const MCP = /^timestamp=(\S+) level=\S+ run=(\S+) message="(server unavailable|MCP connection closed)" (?:key|server)=(\S+)/;

// The first line of every `opencode` command in OpenCode 2. A command that only asks the
// running OpenCode something (`opencode api ...`, as the monitor itself does, or `opencode
// service status`) writes this line under a run id of its own and nothing more: it is not an
// OpenCode that holds sessions. A run counts from its second line on.
const CLI_START = /^timestamp=\S+ level=\S+ run=\S+ message="cli starting" /;
// Each OpenCode that starts says its version: the one installed and running now. A session's
// own version is of the OpenCode that created it, which a 1.x session carried on in 2 keeps.
const CLI_VERSION = / version=(\d+\.\d+\.\d+[^\s]*)/;

// OpenCode 2 connects each MCP server once per folder it has loaded, and says how it went. A
// server that failed (a timeout after a network blip) is not tried again by itself.
const MCP_V2 = /^timestamp=(\S+) level=\S+ run=(\S+) message="(mcp connect failed|mcp connected)" server=(\S+)/;
const QUOTED_OR_WORD = '("(?:[^"\\\\]|\\\\.)*"|\\S+)';
const DIRECTORY = new RegExp(` directory=${QUOTED_OR_WORD}`);
const STATUS_ERROR = new RegExp(` status\\.error=${QUOTED_OR_WORD}`);
const unquote = text => {
  if (!text?.startsWith('"')) return text ?? null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/** { t, run, name, directory, ok, error } of an OpenCode 2 MCP connection line, or null. */
export function parseMcpConnectLine(line) {
  const m = MCP_V2.exec(line);
  const t = m ? Date.parse(m[1]) : Number.NaN;
  if (Number.isNaN(t)) return null;
  const directory = unquote(DIRECTORY.exec(line)?.[1]);
  if (!directory) return null;
  const ok = m[3] === 'mcp connected';
  return { t, run: m[2], name: m[4], directory, ok, error: ok ? null : String(unquote(STATUS_ERROR.exec(line)?.[1]) ?? '').slice(0, 200) };
}

// OpenCode 2 puts a project away after an hour without activity. A question or a permission
// prompt left open goes with it: its call is interrupted and the session stops.
const EVICTED = /^timestamp=(\S+) level=\S+ run=\S+ message="location services evicted" directory=("(?:[^"\\]|\\.)*"|\S+)/;
const MAX_EVICTIONS = 500;

/** { t, directory } of a "location services evicted" line, or null. */
export function parseEvictedLine(line) {
  const m = EVICTED.exec(line);
  const t = m ? Date.parse(m[1]) : Number.NaN;
  if (Number.isNaN(t)) return null;
  let directory = m[2];
  try {
    if (directory.startsWith('"')) directory = JSON.parse(directory);
  } catch {
    return null;
  }
  return { t, directory };
}

// What OpenCode logs last when it exits by itself.
const DISPOSE = /^timestamp=\S+ level=\S+ run=\S+ message="disposing (?:all instances|instance)"/;
// A few lines can still follow the last "disposing" line of a run that has ended.
const LINES_AFTER_DISPOSE = 3;

/**
 * Which OpenCode processes are still there, as far as the log can tell.
 *
 * The newest line alone is not enough: a one-off command (`opencode mcp list`) or a second
 * window writes lines too, and would hide what the window you are working in logged.
 * A run that logged its own shutdown is over. Of the rest, the one that wrote last is alive,
 * and so is any other that has written since that one started.
 *
 * @param {Map<string, {first: number, last: number, afterDispose: number|null}>} runs
 * @returns {Set<string>}
 */
export function liveRuns(runs) {
  const open = [...runs].filter(([, r]) => r.afterDispose == null || r.afterDispose > LINES_AFTER_DISPOSE);
  if (!open.length) return new Set();
  const newest = open.reduce((a, b) => (b[1].last >= a[1].last ? b : a), open[0]);
  return new Set(open.filter(([, r]) => r.last >= newest[1].first).map(([id]) => id));
}

const REPLY = /^timestamp=(\S+) level=\S+ run=\S+ message=replied requestID=(que_\S+)/;

/** The answer to a question prompt: { t, id }. Permission answers are not logged. */
export function parseReplyLine(line) {
  const m = REPLY.exec(line);
  const t = m ? Date.parse(m[1]) : Number.NaN;
  return Number.isNaN(t) ? null : { t, id: m[2] };
}

export function parseAskLine(line) {
  const m = ASK.exec(line);
  if (!m) return null;
  const t = Date.parse(m[1]);
  if (Number.isNaN(t)) return null;
  return {
    t,
    run: m[2],
    id: m[3],
    kind: m[4] === 'per' ? 'permission' : 'question',
    permission: m[5] ?? null,
    patterns: m[6] ? cleanPatterns(m[6]) : '',
  };
}

/** "server unavailable" = never started in that run; "MCP connection closed" = died later. */
export function parseMcpLine(line) {
  const m = MCP.exec(line);
  if (!m) return null;
  const t = Date.parse(m[1]);
  if (Number.isNaN(t)) return null;
  return { t, run: m[2], kind: m[3] === 'server unavailable' ? 'unavailable' : 'closed', name: m[4] };
}

// patterns="[\"npm run test\"]" -> npm run test
function cleanPatterns(raw) {
  let text = raw.trim();
  try {
    if (text.startsWith('"')) text = JSON.parse(text);
    const list = JSON.parse(text);
    if (Array.isArray(list)) return list.join(' , ');
  } catch {
    // Not the shape we expected; show it as logged.
  }
  return text;
}

export function createLogTail(path) {
  let offset = 0;
  let carry = '';
  let asks = [];
  let mcpEvents = []; // every MCP failure line read, oldest first
  let evictions = []; // projects OpenCode 2 put away, oldest first
  let version = null; // of the OpenCode that started last
  let connections = new Map(); // "server|folder" -> its latest OpenCode 2 connection line
  let mcpMarked = []; // the same, each marked as a shutdown or not
  let mcpFailures = new Map(); // server name -> its latest failure in a live run that was not a shutdown
  let firstAt = null; // time of the oldest line read: nothing is known from before it
  let replies = new Map(); // question id -> when it was answered
  let lastRun = null; // id of the OpenCode process that wrote the newest line
  let runEnds = new Map(); // run id -> time of its last line
  let runs = new Map(); // run id -> { first, last, afterDispose }
  let live = new Set(); // runs still going, see liveRuns
  let started = false;

  function reset() {
    offset = 0;
    carry = '';
    asks = [];
    mcpEvents = [];
    evictions = [];
    version = null;
    connections = new Map();
    mcpMarked = [];
    mcpFailures = new Map();
    firstAt = null;
    replies = new Map();
    runEnds = new Map();
    runs = new Map();
    live = new Set();
    lastRun = null;
  }

  // Which run wrote the line, and whether that run is winding down.
  function noteRun(line, id, at) {
    lastRun = id;
    if (Number.isNaN(at)) return;
    runEnds.set(id, at);
    firstAt ??= at;
    const run = runs.get(id) ?? { first: at, last: at, afterDispose: null };
    run.last = at;
    if (DISPOSE.test(line)) run.afterDispose = 0;
    else if (run.afterDispose != null) run.afterDispose++;
    runs.set(id, run);
  }

  function take(line) {
    const prefix = PREFIX.exec(line);
    if (!prefix) return;
    if (CLI_START.test(line)) {
      version = CLI_VERSION.exec(line)?.[1] ?? version;
      return;
    }
    noteRun(line, prefix[2], Date.parse(prefix[1]));
    if (line.includes('message=asking')) {
      const ask = parseAskLine(line);
      if (ask) asks.push(ask);
    } else if (line.includes('message=replied')) {
      const reply = parseReplyLine(line);
      if (reply) replies.set(reply.id, reply.t);
    } else if (line.includes('message="server unavailable"') || line.includes('message="MCP connection closed"')) {
      const failure = parseMcpLine(line);
      if (failure) mcpEvents.push(failure);
    } else if (line.includes('message="mcp connect')) {
      const c = parseMcpConnectLine(line);
      if (c) connections.set(`${c.name}|${c.directory}`, c);
    } else if (line.includes('message="location services evicted"')) {
      const evicted = parseEvictedLine(line);
      if (evicted) evictions.push(evicted);
      if (evictions.length > MAX_EVICTIONS) evictions = evictions.slice(-MAX_EVICTIONS);
    }
  }

  function poll() {
    let fd;
    try {
      fd = openSync(path, 'r');
    } catch {
      return; // No log yet; prompts simply cannot be detected until it appears.
    }
    try {
      const { size } = fstatSync(fd);
      if (size < offset) reset(); // Rotated or truncated: start over.
      if (!started) {
        started = true;
        offset = Math.max(0, size - MAX_INITIAL_BYTES);
      }
      if (size === offset) return;
      const buffer = Buffer.alloc(size - offset);
      const read = readSync(fd, buffer, 0, buffer.length, offset);
      offset += read;
      const lines = (carry + buffer.toString('utf8', 0, read)).split('\n');
      carry = lines.pop();
      for (const line of lines) take(line);
      if (mcpEvents.length > MAX_MCP_EVENTS) mcpEvents = mcpEvents.slice(-MAX_MCP_EVENTS);
      // Whether a close was a shutdown depends on what its run wrote afterwards, so every
      // read can change the answer for the newest lines.
      live = liveRuns(runs);
      mcpMarked = markShutdowns(mcpEvents, runEnds, live);
      mcpFailures = latestFailures(mcpMarked.filter(e => live.has(e.run)));
      // OpenCode 2: a server whose latest connection in some folder failed, in a run still going,
      // and not connected there since. Newer than what 1.x lines said, it is what counts.
      for (const c of connections.values()) {
        if (c.ok || !live.has(c.run)) continue;
        const known = mcpFailures.get(c.name);
        if (!known || c.t > known.t) mcpFailures.set(c.name, { t: c.t, run: c.run, kind: 'unavailable', name: c.name, directory: c.directory, error: c.error });
      }
      if (asks.length > MAX_ASKS) asks = asks.slice(-MAX_ASKS);
      if (replies.size > MAX_ASKS) replies = new Map([...replies].slice(-MAX_ASKS));
    } finally {
      closeSync(fd);
    }
  }

  return {
    poll,
    asks: () => asks,
    replies: () => replies,
    evictions: () => evictions,
    /** The version of the OpenCode that started last, as its log says; null before any. */
    opencodeVersion: () => version,
    /** OpenCode 2: each server and folder whose latest connection failed, in a run still going. */
    mcpDisconnected: () => [...connections.values()].filter(c => !c.ok && live.has(c.run)),
    runEnds: () => runEnds,
    mcpFailures: () => mcpFailures,
    mcpEvents: () => mcpMarked,
    firstAt: () => firstAt,
    lastRun: () => lastRun,
    liveRuns: () => live,
  };
}
