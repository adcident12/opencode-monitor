// A prompt nobody answered: OpenCode 2 puts the project away after an hour, and the session stops.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogTail, parseEvictedLine } from '../src/logtail.mjs';
import { deriveState } from '../src/state.mjs';
import { createNotifier } from '../src/notify.mjs';
import { DEFAULTS } from '../src/config.mjs';

const T = Date.parse('2026-10-11T21:02:36.894Z');
const LINE = 'timestamp=2026-10-11T21:02:36.894Z level=INFO run=e6a853a6 message="location services evicted" directory="E:\\\\queue-appointment-management" workspaceID=undefined role=server';

test('the log says when OpenCode put a project away', () => {
  assert.deepEqual(parseEvictedLine(LINE), { t: T, directory: 'E:\\queue-appointment-management' });
  assert.deepEqual(parseEvictedLine(LINE.replace('"E:\\\\queue-appointment-management"', '/home/me/shop')), { t: T, directory: '/home/me/shop' });
  assert.equal(parseEvictedLine(LINE.replace('evicted', 'booted')), null);
  // Text inside a logged command cannot pose as the line.
  assert.equal(parseEvictedLine(`timestamp=2026-10-11T21:02:36.894Z level=INFO run=x message="spawning process" command="echo message=\\"location services evicted\\" directory=/x"`), null);

  const dir = mkdtempSync(join(tmpdir(), 'ocm-evict-'));
  try {
    const file = join(dir, 'opencode.log');
    appendFileSync(file, `${LINE}\n`);
    const log = createLogTail(file);
    log.poll();
    assert.deepEqual(log.evictions(), [{ t: T, directory: 'E:\\queue-appointment-management' }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const session = directory => ({ id: 's', directory, time_created: T - 7_200_000 });
const messages = (error = 'MessageAbortedError', completed = T - 20) => [
  { id: 'u', role: 'user', time_created: T - 7_000_000 },
  { id: 'a', role: 'assistant', time_created: T - 3_900_000, completed, error, finish: 'error' },
];
const state = (directory, evictions, msgs = messages()) => deriveState({ session: session(directory), parts: [], messages: msgs, asks: [], now: T + 60_000, thresholds: DEFAULTS.thresholds, opencodeRunning: true, evictions });

test('interrupted at the moment its project was put away: dropped by OpenCode, not stopped by you', () => {
  const evictions = [{ t: T, directory: 'E:\\queue-appointment-management' }];
  // The session's own directory, however its slashes and letters are written.
  assert.deepEqual([state('E:/queue-appointment-management', evictions).state, state('E:/queue-appointment-management', evictions).reason], ['idle', 'dropped']);
  assert.equal(state('e:\\Queue-Appointment-Management\\', evictions).reason, 'dropped');
  // Another project put away at that moment, or this one at another moment: you stopped it.
  assert.equal(state('E:/sonic', evictions).reason, 'aborted');
  assert.equal(state('E:/queue-appointment-management', [{ t: T - 600_000, directory: 'E:\\queue-appointment-management' }]).reason, 'aborted');
  assert.equal(state('E:/queue-appointment-management', []).reason, 'aborted');
  // A reply that failed is an error whatever was put away.
  assert.deepEqual([state('E:/queue-appointment-management', evictions, messages('APIError')).state, state('E:/queue-appointment-management', evictions, messages('APIError')).reason], ['error', 'message_error']);
});

test('an error is told once it has lasted a minute; one OpenCode retries at once is not', () => {
  const sent = [];
  const send = { desktop: (title, body, done) => { sent.push(title); done(null); }, discord: async () => null };
  const notify = createNotifier({ ...DEFAULTS.notify, desktop: true, repeatMinutes: 30 }, key => key, send, { quiet: true });
  const s = (state, since) => ({ id: 's', parentId: null, state, reason: state === 'error' ? 'message_error' : 'tool', since, project: 'shop', title: 'Add checkout', health: { hints: [], compactions: 0 } });
  notify([s('working', T - 9000)], T - 9000);
  // bad allocation, and OpenCode asks again two seconds later
  notify([s('error', T)], T);
  notify([s('working', T + 2000)], T + 2000);
  assert.deepEqual(sent, []);
  // the server is down: still failed after a minute, told once, and again only when due
  notify([s('error', T + 10_000)], T + 10_000);
  notify([s('error', T + 10_000)], T + 40_000);
  assert.deepEqual(sent, []);
  notify([s('error', T + 10_000)], T + 72_000);
  notify([s('error', T + 10_000)], T + 80_000);
  notify([s('error', T + 10_000)], T + 600_000);
  assert.deepEqual(sent, ['notify.error']);
  notify([s('error', T + 10_000)], T + 72_000 + 30 * 60_000);
  assert.deepEqual(sent, ['notify.error', 'notify.error']);
});

test('told once when a prompt was dropped, and only if asked for', () => {
  const sent = [];
  const send = { desktop: (title, body, done) => { sent.push([title, body]); done(null); }, discord: async () => null };
  const cfg = { ...DEFAULTS.notify, desktop: true, repeatMinutes: 30 };
  assert.ok(cfg.on.includes('dropped'), 'on by default');
  const t = key => key;
  const s = (state, reason) => ({ id: 's', parentId: null, state, reason, since: T - 3_600_000, project: 'shop', title: 'Add checkout', health: { hints: [], compactions: 0 } });

  const notify = createNotifier(cfg, t, send, { quiet: true });
  notify([s('working', 'tool')], T - 3_700_000); // what is there at startup is not news
  notify([s('waiting', 'question')], T - 3_600_000);
  notify([s('idle', 'dropped')], T);
  notify([s('idle', 'dropped')], T + 2000);
  notify([s('idle', 'dropped')], T + 3_600_000); // not repeated: nothing waits any more
  assert.deepEqual(sent.map(m => m[0]), ['notify.waiting', 'notify.dropped']);
  assert.match(sent[1][1], /shop — Add checkout · notify\.dropped\.body/);
  assert.deepEqual(notify.recent().map(e => e.kind), ['dropped', 'waiting']);

  // Stopped by you: no notification. Dropped before the monitor started: not news.
  sent.length = 0;
  const quiet = createNotifier(cfg, t, send, { quiet: true });
  quiet([s('idle', 'dropped')], T);
  quiet([s('idle', 'dropped')], T + 2000);
  const own = createNotifier(cfg, t, send, { quiet: true });
  own([s('waiting', 'question')], T - 10_000);
  own([s('idle', 'aborted')], T);
  // Switched off.
  const off = createNotifier({ ...cfg, on: ['waiting', 'stuck', 'error'] }, t, send, { quiet: true });
  off([s('working', 'tool')], T - 10_000);
  off([s('idle', 'dropped')], T);
  assert.deepEqual(sent, []);
});

test('a question given up on is not counted as a slow tool call', async () => {
  const { computeStats } = await import('../src/stats.mjs');
  const { promptsFor } = await import('../src/pending.mjs');
  const q = { id: 'q', v2: true, session_id: 's', tool: 'question', status: 'error', error: 'Tool execution interrupted', time_created: T - 3_618_100, started: T - 3_618_000, ended: T, time_updated: T };
  const tools = [q, { id: 'r', v2: true, session_id: 's', tool: 'read', status: 'completed', time_created: T - 5000, started: T - 5000, ended: T - 4000, time_updated: T - 4000 }];
  const prompts = promptsFor({ asks: () => [], replies: () => new Map() }, tools);
  const stats = computeStats({ sessions: [{ id: 's', parent_id: null, directory: '/w', title: 'S', time_created: T - 7_200_000, time_updated: T }], tools, messages: [], compactions: [], asks: prompts.asks, replies: prompts.replies, eventTimes: new Map(), now: T + 60_000, days: 7, stuckMs: 600_000, show: x => String(x ?? '') });
  assert.deepEqual(stats.slow.map(s => [s.tool, s.runMs]), [['read', 1000], ['question', 0]]);
  assert.deepEqual(stats.waits.map(w => [w.kind, w.waitMs, w.answered, w.abandoned]), [['question', 3_618_000, false, true]]);
});

test('a skill call is described by its name; one file is "1 file"', async () => {
  const { describePart } = await import('../src/state.mjs');
  const { loadTranslator } = await import('../src/format.mjs');
  assert.equal(describePart({ tool: 'skill', skill: 'executing-plans', input: '{"id":"executing-plans"}' }), 'executing-plans');
  assert.equal(describePart({ tool: 'graft_find', skill: 'x', input: '{"name":"x"}' }), '{"name":"x"}');
  const en = loadTranslator('en');
  const th = loadTranslator('th');
  assert.deepEqual([en('work.files', { n: 1 }), en('work.files', { n: 2 }), en('work.files', { n: 0 })], ['1 file touched', '2 files touched', '0 files touched']);
  assert.ok(!/files/.test(th('work.files', { n: 1 })));
});

test('OpenCode is gone only when two process lists in a row do not have it', async () => {
  const { createProcessProbe } = await import('../src/process.mjs');
  const lists = ['"opencode.exe","1","Console","1","1 K"', '', '"opencode.exe","1","Console","1","1 K"', '', ''];
  const probe = createProcessProbe(['opencode'], { everyMs: 0, run: async () => lists.shift() });
  const seen = [];
  for (let i = 0; i < 5; i++) {
    await probe.refresh();
    seen.push(probe.running);
  }
  if (process.platform === 'win32') assert.deepEqual(seen, [true, true, true, true, false]);
  else assert.equal(seen.at(-1), false);
});

test('an execute script is described by its code, a call with no input yet by nothing', async () => {
  const { describePart } = await import('../src/state.mjs');
  const { normalizeV2 } = await import('../src/db-v2.mjs');
  const code = 'await tools["chrome-devtools"].take_snapshot({ pageId: 2 })';
  const row = { id: 'm', session_id: 's', type: 'assistant', time_created: T, time_updated: T, data: JSON.stringify({ time: { created: T }, content: [
    { type: 'tool', id: 'a', name: 'execute', state: { status: 'running', input: { code } }, time: { created: T } },
    { type: 'tool', id: 'b', name: 'execute', state: { status: 'running', input: {} }, time: { created: T } },
    { type: 'tool', id: 'c', name: 'execute', state: { status: 'completed', input: { code }, metadata: { toolCalls: [{ tool: 'chrome-devtools.take_snapshot', status: 'completed', input: { pageId: 2 } }] } }, time: { created: T, ran: T, completed: T + 9 } },
  ] }) };
  assert.deepEqual(normalizeV2([row]).tools.map(describePart), [code, '', '{"pageId":2}']);
});

test('a file read by an absolute path and by a relative one is one file', async () => {
  const { computeStats } = await import('../src/stats.mjs');
  const { inProject } = await import('../src/work.mjs');
  assert.equal(inProject('E:\\shop\\src\\a.ts', 'E:/shop', 'win32'), 'src/a.ts');
  assert.equal(inProject('e:/Shop/src/a.ts', 'E:\\shop\\', 'win32'), 'src/a.ts');
  assert.equal(inProject('/home/me/shop/src/a.ts', '/home/me/shop', 'linux'), 'src/a.ts');
  assert.equal(inProject('/home/me/Shop/src/a.ts', '/home/me/shop', 'linux'), '/home/me/Shop/src/a.ts');
  assert.equal(inProject('C:\\other\\b.ts', 'E:/shop', 'win32'), 'C:/other/b.ts');
  const dir = process.platform === 'win32' ? 'E:/shop' : '/work/shop';
  const abs = process.platform === 'win32' ? 'E:\\shop\\src\\a.ts' : '/work/shop/src/a.ts';
  const read = (id, file, t) => ({ id, session_id: 's', tool: 'read', status: 'completed', file, time_created: t, started: t, ended: t + 5, time_updated: t + 5 });
  const tools = [read('1', 'src/a.ts', T - 50_000), read('2', abs, T - 40_000), read('3', 'src/a.ts', T - 30_000)];
  const stats = computeStats({ sessions: [{ id: 's', parent_id: null, directory: dir, title: 'S', time_created: T - 90_000, time_updated: T }], tools, messages: [], compactions: [], asks: [], replies: new Map(), eventTimes: new Map(), now: T + 60_000, days: 7, stuckMs: 600_000, show: x => String(x ?? '') });
  assert.deepEqual(stats.rereads.map(r => [r.file, r.count]), [['src/a.ts', 3]]);
  assert.equal(stats.totals.rereads, 1);
});
