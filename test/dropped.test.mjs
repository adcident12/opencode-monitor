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
  const off = createNotifier({ ...cfg, on: ['waiting', 'stuck'] }, t, send, { quiet: true });
  off([s('working', 'tool')], T - 10_000);
  off([s('idle', 'dropped')], T);
  assert.deepEqual(sent, []);
});
