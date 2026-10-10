// Notices when an OpenCode config file changes, and keeps what changed, so a day in Stats can
// be compared with the days before it. Also changes made while the monitor was not running:
// the last settings seen are kept, and a difference found at start is dated by the file.
//
// The config holds API keys and MCP credentials. Settings whose name says secret are never
// read; text values are kept only when they are a plain setting word or a model name, and
// otherwise only as a hash, so "changed" can be said without saying to what.
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { stripJsonc } from './opencode-config.mjs';

const DAY_MS = 86_400_000;
const MAX_DEPTH = 10;
const MAX_SETTINGS = 4000;
const MAX_CHANGES = 40; // per entry; the rest are counted
const MAX_BYTES = 1024 * 1024;
const MAX_ENTRIES = 2000;

const SECRET_NAME = /api.?key|token|secret|passw|credential|cookie|authorization|bearer/i;
const SECRET_SEGMENT = new Set(['key', 'auth', 'header', 'headers', 'env', 'environment']);
// Text worth showing as it is: what a setting is set to, not where or with what key.
const SHOWN_KEYS = new Set(['model', 'small_model', 'default_agent', 'agent', 'type', 'npm', 'share', 'autoupdate', 'theme', 'mode', 'reasoningEffort', 'reasoning_effort', 'textVerbosity', 'logLevel']);
const SHOWN_WORD = /^(allow|ask|deny|auto|manual|disabled|enabled|none|minimal|low|medium|high|max|xhigh|true|false|local|remote)$/i;

const hash = value => `#${createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16)}`;

/**
 * The config as path -> value, one line per setting. Numbers and true/false are kept;
 * text only when it is safe to show (see above), otherwise a hash; lists as a hash.
 * @returns {Map<string, number|boolean|string|null>}
 */
export function flattenSettings(config) {
  const out = new Map();
  const walk = (value, path, depth) => {
    if (out.size >= MAX_SETTINGS) return;
    const leaf = path.at(-1) ?? '';
    if (path.some(p => SECRET_NAME.test(p) || SECRET_SEGMENT.has(p.toLowerCase()))) return;
    if (value && typeof value === 'object' && !Array.isArray(value) && depth < MAX_DEPTH) {
      for (const [k, v] of Object.entries(value)) walk(v, [...path, k], depth + 1);
      return;
    }
    const key = path.join('.');
    if (!key) return;
    if (value === null || typeof value === 'number' || typeof value === 'boolean') out.set(key, value);
    // A model name has one slash at most; an address or a path has more, or ':', '@', '\'.
    else if (typeof value === 'string' && value.length <= 120 && (SHOWN_WORD.test(value) || (SHOWN_KEYS.has(leaf) && /^[\w.-]+(\/[\w.:-]+)?$/.test(value) && !value.includes('://')))) out.set(key, value);
    else out.set(key, hash(value));
  };
  walk(config, [], 0);
  return out;
}

const hidden = v => typeof v === 'string' && v.startsWith('#');

/**
 * What differs between two flattened configs, by path. A value that was only kept as a hash
 * is reported as changed without its values.
 * @returns {{changes: {path: string, from?: *, to?: *, hidden?: true, kind: string}[], more: number}}
 */
export function diffSettings(before, after) {
  const all = [];
  for (const path of new Set([...before.keys(), ...after.keys()])) {
    const a = before.has(path) ? before.get(path) : undefined;
    const b = after.has(path) ? after.get(path) : undefined;
    if (a === b) continue;
    const kind = a === undefined ? 'added' : b === undefined ? 'removed' : 'changed';
    all.push(hidden(a) || hidden(b) ? { path, kind, hidden: true } : { path, kind, from: a ?? null, to: b ?? null });
  }
  all.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
  return { changes: all.slice(0, MAX_CHANGES), more: Math.max(0, all.length - MAX_CHANGES) };
}

function readConfig(path, fs) {
  try {
    const st = fs.statSync(path);
    if (!st.isFile() || st.size > MAX_BYTES) return null;
    return { mtime: st.mtimeMs, size: st.size, config: JSON.parse(stripJsonc(fs.readFileSync(path, 'utf8'))) };
  } catch {
    return null; // missing, unreadable, or half-saved: look again next time
  }
}

const warn = (what, err) => console.warn(`Could not write ${what}: ${err.code ?? err.message}`);

/** Changes kept on disk, past retention left out (and dropped from the file, as history does). */
function loadEntries(file, cutoff) {
  if (!file || !existsSync(file)) return [];
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const entries = [];
  for (const line of lines) {
    try {
      const e = JSON.parse(line);
      if (e?.t >= cutoff && e.file && Array.isArray(e.changes)) entries.push(e);
    } catch {
      // a half-written line from a crash
    }
  }
  if (entries.length !== lines.length) {
    try {
      writeFileSync(file, entries.map(e => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''));
    } catch (err) {
      warn(file, err);
    }
  }
  return entries.slice(-MAX_ENTRIES);
}

/** @returns {Map<string, {mtime: number, size: number, settings: Map}>} */
function loadSeen(seenFile) {
  const seen = new Map();
  if (!seenFile || !existsSync(seenFile)) return seen;
  try {
    for (const [path, s] of Object.entries(JSON.parse(readFileSync(seenFile, 'utf8')))) seen.set(path, { mtime: s.mtime, size: s.size, settings: new Map(Object.entries(s.settings)) });
  } catch {
    // a broken file: start again from what is there now
  }
  return seen;
}

/**
 * @param {object} o
 * @param {() => string[]} o.files     config files to watch, each an absolute path
 * @param {string|null} o.file          JSON Lines of changes; null keeps them in memory
 * @param {string|null} o.seenFile      the last settings seen per file, to notice changes made
 *   while the monitor was not running; null forgets them on exit
 * @param {number} o.retentionDays
 * @param {number} [o.everyMs]
 */
export function createConfigWatch({ files, file = null, seenFile = null, retentionDays = 30, everyMs = 60_000, now = Date.now(), fs = { statSync, readFileSync } }) {
  let entries = loadEntries(file, now - retentionDays * DAY_MS);
  const seen = loadSeen(seenFile);
  let checkedAt = -Infinity;

  const save = added => {
    try {
      if (file && added.length) {
        mkdirSync(dirname(file), { recursive: true });
        appendFileSync(file, added.map(e => JSON.stringify(e)).join('\n') + '\n');
      }
    } catch (err) {
      warn(file, err);
    }
    try {
      if (seenFile) {
        mkdirSync(dirname(seenFile), { recursive: true });
        writeFileSync(seenFile, JSON.stringify(Object.fromEntries([...seen].map(([p, s]) => [p, { mtime: s.mtime, size: s.size, settings: Object.fromEntries(s.settings) }]))));
      }
    } catch (err) {
      warn(seenFile, err);
    }
  };

  /** One file: null when it has not moved or cannot be read, else what changed (maybe nothing). */
  const look = (path, at) => {
    const known = seen.get(path);
    let st;
    try {
      st = fs.statSync(path);
    } catch {
      return null; // a file that went away is not a change of settings
    }
    if (known && known.mtime === st.mtimeMs && known.size === st.size) return null;
    const read = readConfig(path, fs);
    if (!read) return null;
    const settings = flattenSettings(read.config);
    seen.set(path, { mtime: read.mtime, size: read.size, settings });
    // The first look at a file is where we start from, not a change.
    if (!known) return { entry: null };
    const { changes, more } = diffSettings(known.settings, settings);
    // Saved while the monitor was off: the file's time says when, not ours.
    return { entry: changes.length ? { t: Math.min(at, Math.round(read.mtime)), file: path, changes, more } : null };
  };

  /** Looks at each file whose time or size moved. @returns {object[]} the new entries */
  function check(at = Date.now(), force = false) {
    if (!force && at - checkedAt < everyMs) return [];
    checkedAt = at;
    const added = [];
    let moved = false;
    for (const path of new Set(files())) {
      const found = look(path, at);
      if (!found) continue;
      moved = true;
      if (found.entry) added.push(found.entry);
    }
    if (added.length) entries = [...entries, ...added].sort((a, b) => a.t - b.t);
    entries = entries.filter(e => e.t >= at - retentionDays * DAY_MS).slice(-MAX_ENTRIES);
    if (moved) save(added);
    return added;
  }

  return {
    check,
    /** Newest first, from `since` on. */
    list: (since = 0) => entries.filter(e => e.t >= since).reverse(),
  };
}
