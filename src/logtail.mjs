// Follows OpenCode's log file for two things the database does not record:
// permission/question prompts, and MCP servers failing.
import { openSync, readSync, closeSync, fstatSync } from 'node:fs';

const MAX_INITIAL_BYTES = 64 * 1024 * 1024;
const MAX_ASKS = 5000;

// Anchored to the fixed prefix so text inside a logged command cannot pose as an event.
const PREFIX = /^timestamp=(\S+) level=\S+ run=(\S+) /;
const ASK = /^timestamp=(\S+) level=\S+ run=(\S+) message=asking id=((per|que)_\S+)(?: permission=(\S+))?(?: patterns=(.*))?/;
const MCP = /^timestamp=(\S+) level=\S+ run=(\S+) message="(server unavailable|MCP connection closed)" (?:key|server)=(\S+)/;

const REPLY = /^timestamp=(\S+) level=\S+ run=\S+ message=replied requestID=(que_\S+)/;

/** The answer to a question prompt: { t, id }. Permission answers are not logged. */
export function parseReplyLine(line) {
  const m = REPLY.exec(line);
  const t = m ? Date.parse(m[1]) : NaN;
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
  let mcpFailures = new Map(); // server name -> its latest failure
  let replies = new Map(); // question id -> when it was answered
  let lastRun = null; // id of the OpenCode process that wrote the newest line
  let runEnds = new Map(); // run id -> time of its last line
  let started = false;

  function poll() {
    let fd;
    try {
      fd = openSync(path, 'r');
    } catch {
      return; // No log yet; prompts simply cannot be detected until it appears.
    }
    try {
      const { size } = fstatSync(fd);
      if (size < offset) {
        // Rotated or truncated: start over.
        offset = 0;
        carry = '';
        asks = [];
        mcpFailures = new Map();
        replies = new Map();
        runEnds = new Map();
        lastRun = null;
      }
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
      for (const line of lines) {
        const prefix = PREFIX.exec(line);
        if (!prefix) continue;
        lastRun = prefix[2];
        const at = Date.parse(prefix[1]);
        if (!Number.isNaN(at)) runEnds.set(lastRun, at);
        if (line.includes('message=asking')) {
          const ask = parseAskLine(line);
          if (ask) asks.push(ask);
        } else if (line.includes('message=replied')) {
          const reply = parseReplyLine(line);
          if (reply) replies.set(reply.id, reply.t);
        } else if (line.includes('message="server unavailable"') || line.includes('message="MCP connection closed"')) {
          const failure = parseMcpLine(line);
          if (failure) mcpFailures.set(failure.name, failure);
        }
      }
      if (asks.length > MAX_ASKS) asks = asks.slice(-MAX_ASKS);
      if (replies.size > MAX_ASKS) replies = new Map([...replies].slice(-MAX_ASKS));
    } finally {
      closeSync(fd);
    }
  }

  return { poll, asks: () => asks, replies: () => replies, runEnds: () => runEnds, mcpFailures: () => mcpFailures, lastRun: () => lastRun };
}
