// What OpenCode 2 is waiting for you to allow. It records a permission prompt neither in its
// database nor in its log: only its background service knows, and `opencode api` asks it.
// The one thing here that is not read from a file. It only ever lists: nothing is answered,
// and a session is asked about only while one of its tool calls is running.
import { exec, execFile } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// How often a session is asked about, by how long it has had a call running: [up to, every].
// A prompt comes when a call starts, so that is when it is looked for closely. A call that has
// run for minutes, or a prompt left unanswered for the night, is asked about less and less:
// every question is a process started and a line in OpenCode's log.
const GAPS = [[120_000, 5000], [1_800_000, 15_000], [Infinity, 60_000]];
const MAX_SESSIONS = 6;
const TIMEOUT_MS = 10_000;
const MAX_ASKS = 5000;
const DAY_MS = 86_400_000;
// Ids go into a command line: nothing but what an OpenCode id is made of.
const ID = /^[A-Za-z0-9_-]{1,80}$/;

/** A line of the file as an entry with an id, or null for one that is not. */
function entryOf(line) {
  try {
    const entry = JSON.parse(line);
    return entry && ID.test(String(entry.id ?? '')) ? entry : null;
  } catch {
    return null;
  }
}

/**
 * Takes one entry into `asks`: a prompt within retention, or the answer to one known. Whether
 * its line is worth keeping in the file.
 */
function takeEntry(asks, entry, cutoff) {
  if (!entry) return false;
  if (typeof entry.t === 'number') {
    if (entry.t < cutoff) return false;
    asks.set(entry.id, { run: null, kind: 'permission', permission: null, patterns: '', session: null, part: null, ...entry, answeredAt: entry.answeredAt ?? null });
    return true;
  }
  if (typeof entry.answeredAt !== 'number' || !asks.has(entry.id)) return false;
  asks.get(entry.id).answeredAt = entry.answeredAt;
  return true;
}

/**
 * When a request was made, from its id. An OpenCode id begins with twelve hex digits: the
 * time in milliseconds, its low 36 bits, then a counter. null for anything else.
 */
export function timeOfId(id, now) {
  const hex = /^[a-z]+_([0-9a-f]{12})/.exec(String(id))?.[1];
  if (!hex) return null;
  const span = 2 ** 36; // 2.2 years
  const low = Math.floor(Number.parseInt(hex, 16) / 4096);
  let t = Math.floor(now / span) * span + low;
  if (t > now + 60_000) t -= span;
  return t;
}

/**
 * `opencode api ...`, its output as text. Rejects when it cannot be run or says no.
 * On Windows through the shell, as you would type it: an OpenCode installed with npm is a
 * .cmd, which only a shell can start, and the shell finds the same OpenCode you use where a
 * direct start would take any opencode.exe on the PATH, an older one included. The line is
 * the command from config.json, fixed words and a checked id: never text from a session.
 */
function runCommand(command, args) {
  const options = { timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 };
  return new Promise((resolve, reject) => {
    const done = (err, stdout) => (err ? reject(err) : resolve(stdout));
    if (process.platform !== 'win32') return execFile(command, args, options, done);
    const quoted = /\s/.test(command) && !command.includes('"') ? `"${command}"` : command;
    return exec([quoted, ...args].join(' '), options, done);
  });
}

/** A request as OpenCode lists it, as a prompt of the kind the log gives for 1.x. */
function askOf(request, sessionId, now, redact) {
  if (!request || !ID.test(String(request.id ?? ''))) return null;
  const resources = Array.isArray(request.resources) ? request.resources.filter(r => typeof r === 'string') : [];
  return {
    t: timeOfId(request.id, now) ?? now,
    run: null,
    id: request.id,
    kind: 'permission',
    permission: typeof request.action === 'string' ? request.action.slice(0, 80) : null,
    // What it asks for can be a whole command: secrets are hidden before it is kept anywhere.
    patterns: redact(resources.join(' , ').slice(0, 1000)),
    session: sessionId,
    // The tool call it is for, so that it is matched by what it is, not by when it came.
    part: typeof request.source?.id === 'string' ? request.source.id.slice(0, 120) : null,
    answeredAt: null,
  };
}

/**
 * @param {object} [deps]
 * @param {boolean} [deps.enabled]   false: never asks, and holds nothing
 * @param {string} [deps.command]    how OpenCode is started on this machine
 * @param {string|null} [deps.file]  where prompts are kept, so that Stats still has them after
 *   a restart; null keeps them in memory
 * @param {boolean} [deps.readOnly]  only read what another process recorded: never ask, never write
 * @param {(text: string) => string} [deps.redact]  hides secrets in what a prompt asks for
 */
export function createPending({ enabled = true, command = 'opencode', file = null, readOnly = false, retentionDays = 30, run = runCommand, redact = text => text } = {}) {
  const asks = new Map(); // id -> ask
  const askedAt = new Map(); // session id -> when it was last asked about
  const wantedSince = new Map(); // session id -> since when it has had a call running
  let sorted = [];
  let busy = 0;
  let status = { ok: null, error: null, at: null }; // of the last listing
  let loadedAt = -1; // modification time of the file when it was read

  const resort = () => {
    sorted = [...asks.values()].sort((a, b) => a.t - b.t).slice(-MAX_ASKS);
  };
  const record = line => {
    if (!file || readOnly) return;
    try {
      appendFileSync(file, `${JSON.stringify(line)}\n`);
    } catch (err) {
      console.warn(`Could not record a prompt in ${file}: ${err.code ?? err.message}`);
    }
  };

  /** What the file holds: a line for each prompt seen, and a line when it was answered. */
  function load(now = Date.now()) {
    if (!file) return;
    let text;
    try {
      const { mtimeMs } = statSync(file);
      if (mtimeMs === loadedAt) return;
      text = readFileSync(file, 'utf8');
      loadedAt = mtimeMs;
    } catch {
      return; // Nothing recorded yet.
    }
    const lines = text.split('\n').filter(Boolean);
    asks.clear();
    const cutoff = now - retentionDays * DAY_MS;
    const kept = lines.filter(line => takeEntry(asks, entryOf(line), cutoff));
    resort();
    // Lines past their time are dropped from the file when it is first read.
    if (!readOnly && kept.length < lines.length) {
      try {
        writeFileSync(file, kept.length ? `${kept.join('\n')}\n` : '');
        loadedAt = statSync(file).mtimeMs;
      } catch {
        // Kept as it is; it is read the same way next time.
      }
    }
  }

  if (file && !readOnly) {
    try {
      mkdirSync(dirname(file), { recursive: true });
    } catch {
      // Recording will say so.
    }
  }
  load();

  /** A prompt no longer listed has been answered (or its call is over): closed at `at`. */
  const close = (ask, at) => {
    if (ask.answeredAt != null) return;
    ask.answeredAt = Math.max(at, ask.t);
    record({ id: ask.id, answeredAt: ask.answeredAt });
  };

  /** The open prompts of sessions no longer running a call: they have moved on. */
  function closeMovedOn(wanted, now) {
    const gone = [...asks.values()].filter(a => a.answeredAt == null && a.session && !wanted.has(a.session));
    for (const a of gone) close(a, now);
    if (gone.length) resort();
  }

  /** What OpenCode listed for one session: new prompts are added, missing ones closed. */
  function apply(sessionId, list, at) {
    const open = new Set();
    for (const request of list) {
      const ask = askOf(request, sessionId, at, redact);
      if (!ask) continue;
      open.add(ask.id);
      if (asks.has(ask.id)) continue;
      asks.set(ask.id, ask);
      // Kept without what only this process knows: which run asked, and when it was answered.
      const line = { ...ask };
      delete line.run;
      delete line.answeredAt;
      record(line);
    }
    for (const ask of asks.values()) if (ask.session === sessionId && !open.has(ask.id)) close(ask, at);
    resort();
  }

  async function ask(sessionId, at) {
    busy++;
    try {
      const out = JSON.parse(await run(command, ['api', 'session.permission.list', '--param', `sessionID=${sessionId}`]));
      if (!Array.isArray(out?.data)) throw new Error('unexpected answer');
      apply(sessionId, out.data, at);
      status = { ok: true, error: null, at };
    } catch (err) {
      // Nothing is closed on a failure: not knowing is not the same as answered.
      status = { ok: false, error: String(err.code ?? err.message ?? err).slice(0, 200), at };
    } finally {
      busy--;
    }
  }

  return {
    /**
     * Ask OpenCode about these sessions: the ones with a tool call running now. Returns at
     * once; what it learns is there for the next reading. A session that had a prompt and is
     * no longer among them has moved on: its prompts are closed.
     * @param {string[]} sessionIds
     */
    check(sessionIds, now = Date.now()) {
      if (!enabled || readOnly) return;
      const wanted = new Set(sessionIds.filter(id => ID.test(id)));
      closeMovedOn(wanted, now);
      for (const id of wantedSince.keys()) if (!wanted.has(id)) wantedSince.delete(id);
      for (const id of wanted) if (!wantedSince.has(id)) wantedSince.set(id, now);
      if (busy) return;
      const gap = id => GAPS.find(([upTo]) => now - wantedSince.get(id) < upTo)[1];
      const due = [...wanted].filter(id => now - (askedAt.get(id) ?? 0) >= gap(id)).slice(0, MAX_SESSIONS);
      for (const id of due) {
        askedAt.set(id, now);
        ask(id, now);
      }
      for (const id of askedAt.keys()) if (!wanted.has(id)) askedAt.delete(id);
    },
    /** Every prompt known, oldest first. */
    asks() {
      if (readOnly) load();
      return sorted;
    },
    /** Prompt id -> when it was answered. */
    replies() {
      if (readOnly) load();
      return new Map(sorted.filter(a => a.answeredAt != null).map(a => [a.id, a.answeredAt]));
    },
    /** Whether the last listing worked: { ok: true|false|null (never asked), error, at }. */
    status: () => ({ enabled: enabled && !readOnly, ...status }),
  };
}

/**
 * The log's prompts and OpenCode 2's together, behind what the log alone offers.
 * @param {object} log      from createLogTail
 * @param {object|null} pending from createPending
 */
export function withPending(log, pending) {
  if (!pending) return log;
  return {
    ...log,
    asks() {
      const more = pending.asks();
      return more.length ? [...log.asks(), ...more].sort((a, b) => a.t - b.t) : log.asks();
    },
    replies() {
      const more = pending.replies();
      return more.size ? new Map([...log.replies(), ...more]) : log.replies();
    },
  };
}

/**
 * The questions OpenCode 2 asked you, from the calls themselves: a `question` call runs from
 * the moment it asks to the moment you answer, and the log says nothing of either. A call that
 * ended any other way was not answered: stopped by you, or dropped by OpenCode itself, which
 * puts a project away after an hour without activity and a question left open with it.
 * @param {object[]} tools  tool rows; only OpenCode 2's are taken
 */
export function questionsOf(tools) {
  const asks = [];
  const replies = new Map();
  for (const p of tools) {
    if (!p.v2 || p.tool !== 'question') continue;
    const t = p.started ?? p.time_created;
    const answered = p.status === 'completed' && p.ended != null;
    // Over without an answer: when, so that it is not counted as waiting until the next message.
    const droppedAt = !answered && p.status === 'error' ? (p.ended ?? p.time_updated ?? null) : null;
    asks.push({ t, run: null, id: p.id, kind: 'question', permission: null, patterns: '', session: p.session_id, part: p.id, answeredAt: answered ? p.ended : null, droppedAt });
    if (answered) replies.set(p.id, p.ended);
  }
  return { asks, replies };
}

/** The prompts for Stats and Replay: the log's, OpenCode 2's permissions, and its questions. */
export function promptsFor(log, tools) {
  const questions = questionsOf(tools);
  if (!questions.asks.length) return { asks: log.asks(), replies: log.replies() };
  return {
    asks: [...log.asks(), ...questions.asks].sort((a, b) => a.t - b.t),
    replies: new Map([...log.replies(), ...questions.replies]),
  };
}
