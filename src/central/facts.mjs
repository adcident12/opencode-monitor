// OpenCode Central: what only the machine itself can see — OpenCode's log, whether OpenCode runs, OpenCode 2's open
// permission prompts, each project's branch — sent as "facts". Kept: times, ids, kinds, names, statuses. Dropped:
// permission patterns (commands, paths), error messages (become filler), real directories (become /machine/folder).
// On the hub, createRemoteSources turns the latest facts back into objects with the methods the monitor calls.
import { FILLER, MAX_FILL, pseudoDir } from './scrub.mjs';
import { UNREADABLE } from '../git.mjs';

/** Every method src/*.mjs calls on a log (createLogTail). The test checks the stand-in has them all. */
export const LOG_METHODS = ['poll', 'asks', 'replies', 'evictions', 'opencodeVersion', 'mcpDisconnected', 'mcpConnected',
  'runEnds', 'mcpFailures', 'mcpEvents', 'firstAt', 'lastRun', 'liveRuns'];

const KEEP = new Set(['t', 'at', 'run', 'id', 'kind', 'permission', 'name', 'ok', 'tools', 'shutdown', 'session', 'part', 'answeredAt']);
const fill = v => (typeof v === 'string' ? FILLER.repeat(Math.min(v.length, MAX_FILL)) : null);

/** One log or prompt entry with only listed, plain values. */
function entry(o, machine) {
  if (!o || typeof o !== 'object') return null;
  const out = {};
  for (const [k, v] of Object.entries(o)) {
    if (k === 'directory') out.directory = pseudoDir(v, machine);
    else if (k === 'error') out.error = v == null ? null : fill(String(v));
    else if (KEEP.has(k) && (v === null || ['string', 'number', 'boolean'].includes(typeof v))) out[k] = typeof v === 'string' ? v.slice(0, 200) : v;
  }
  return out;
}

const list = (v, machine) => (Array.isArray(v) ? v.map(e => entry(e, machine)).filter(Boolean) : []);
const pairs = (m, f = x => x) => (m instanceof Map ? [...m].map(([k, v]) => [String(k), f(v)]) : []);
const call = (o, m, fallback) => (typeof o?.[m] === 'function' ? o[m]() : fallback);

/**
 * @param {{ log, probe, pending, git, directories: string[], machine: string, hmacKey?: Buffer, os?: string, now?: number }} o
 *   directories: the real project folders of recent sessions, whose branches are looked up here.
 */
export function collectFacts({ log, probe, pending, git, directories = [], machine, os = process.platform, now = Date.now() }) {
  const branches = {};
  for (const dir of directories) {
    const b = git?.get?.(dir);
    if (b) branches[pseudoDir(dir, machine)] = { branch: typeof b.branch === 'string' ? b.branch.slice(0, 200) : null, detached: !!b.detached, state: String(b.state ?? '') };
  }
  return {
    at: now,
    os,
    running: probe?.running ?? null,
    opencodeVersion: call(log, 'opencodeVersion', null),
    log: {
      asks: list(call(log, 'asks', []), machine),
      replies: pairs(call(log, 'replies', null)),
      evictions: list(call(log, 'evictions', []), machine),
      mcpDisconnected: list(call(log, 'mcpDisconnected', []), machine),
      mcpConnected: pairs(call(log, 'mcpConnected', null), v => entry(v, machine)),
      runEnds: pairs(call(log, 'runEnds', null)),
      mcpFailures: pairs(call(log, 'mcpFailures', null), v => entry(v, machine)),
      mcpEvents: list(call(log, 'mcpEvents', []), machine),
      firstAt: call(log, 'firstAt', null),
      lastRun: call(log, 'lastRun', null),
      liveRuns: [...(call(log, 'liveRuns', null) ?? [])],
    },
    pending: { asks: list(call(pending, 'asks', []), machine), replies: pairs(call(pending, 'replies', null)) },
    branches,
  };
}

/**
 * The hub's stand-ins for one machine, answering from its latest facts (null before any).
 * @param {() => object|null} getFacts
 */
export function createRemoteSources(getFacts) {
  const f = () => getFacts() ?? null;
  const lg = () => f()?.log ?? {};
  const log = {
    poll() {},
    asks: () => lg().asks ?? [],
    replies: () => new Map(lg().replies ?? []),
    evictions: () => lg().evictions ?? [],
    opencodeVersion: () => f()?.opencodeVersion ?? null,
    mcpDisconnected: () => lg().mcpDisconnected ?? [],
    mcpConnected: () => new Map(lg().mcpConnected ?? []),
    runEnds: () => new Map(lg().runEnds ?? []),
    mcpFailures: () => new Map(lg().mcpFailures ?? []),
    mcpEvents: () => lg().mcpEvents ?? [],
    firstAt: () => lg().firstAt ?? null,
    lastRun: () => lg().lastRun ?? null,
    liveRuns: () => new Set(lg().liveRuns ?? []),
  };
  const probe = { refresh: async () => {}, get running() { return f()?.running ?? null; } };
  const pending = {
    check() {},
    asks: () => f()?.pending?.asks ?? [],
    replies: () => new Map(f()?.pending?.replies ?? []),
  };
  const git = { refresh: async () => {}, get: dir => f()?.branches?.[dir] ?? UNREADABLE };
  return { log, probe, pending, git };
}
