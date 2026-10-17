// While you were away: the night's sessions from the record of state changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOvernight, morningDue, nightOf, overnightLines, overnightOf } from '../src/overnight.mjs';
import { createHistory } from '../src/history.mjs';

const MIN = 60_000;
const HOUR = 60 * MIN;
// 22:00 local, the night of the 12th to the 13th.
const NIGHT = new Date(2026, 9, 12, 22, 0, 0).getTime();
const t = (key, vars = {}) => `${key}${Object.keys(vars).length ? ` ${JSON.stringify(vars)}` : ''}`;
const event = (id, at, to, extra = {}) => ({ t: at, id, title: `Task ${id}`, project: 'shop', to, reason: null, ...extra });

test('the night is the latest stretch from the evening hour that has begun', () => {
  const at3 = new Date(2026, 9, 13, 3, 0).getTime();
  assert.deepEqual(nightOf(at3, 22, 8), { from: NIGHT, to: at3, going: true });
  const at14 = new Date(2026, 9, 13, 14, 0).getTime();
  assert.deepEqual(nightOf(at14, 22, 8), { from: NIGHT, to: NIGHT + 10 * HOUR, going: false });
  // Away in the day: from 9 to 17.
  assert.deepEqual(nightOf(at14, 9, 17), { from: new Date(2026, 9, 13, 9).getTime(), to: at14, going: true });
});

test('the morning report falls due once the night has ended, until the next begins, and once', () => {
  const at8 = new Date(2026, 9, 13, 8, 0).getTime();
  assert.equal(morningDue({ now: at8 + MIN, from: 22, to: 8 }), at8);
  // Started at noon: the morning's report is still sent.
  assert.equal(morningDue({ now: at8 + 4 * HOUR, from: 22, to: 8 }), at8);
  assert.equal(morningDue({ now: at8 + MIN, from: 22, to: 8, lastSent: at8 }), null);
  // Still night: nothing, not even the night before.
  assert.equal(morningDue({ now: at8 - MIN, from: 22, to: 8 }), null);
});

test('each session: worked, waited, how it stood at the end; and the hours nothing ran while one waited', () => {
  const end = NIGHT + 10 * HOUR;
  const report = overnightOf({
    from: NIGHT,
    to: end,
    // a was working when the night began; c had finished the evening before.
    before: new Map([['a', event('a', NIGHT - HOUR, 'working')], ['c', event('c', NIGHT - 2 * HOUR, 'finished')]]),
    events: [
      // a: the model server went down at 03:35, and nothing ran until morning.
      event('a', NIGHT + 5 * HOUR + 35 * MIN, 'error', { reason: 'message_error', error: 'ConnectionRefused' }),
      // b: worked an hour and finished.
      event('b', NIGHT + HOUR, 'working'),
      event('b', NIGHT + 2 * HOUR, 'finished', { reason: 'done' }),
    ],
    planOf: id => (id === 'a' ? { plan: { done: 3, total: 8 }, left: 5 } : null),
  });
  assert.deepEqual(report.sessions.map(s => [s.id, s.state, s.unfinished]), [['a', 'error', true], ['b', 'finished', false]]);
  const a = report.sessions[0];
  assert.equal(a.workedMs, 5 * HOUR + 35 * MIN);
  assert.equal(a.waitedMs, 4 * HOUR + 25 * MIN);
  assert.deepEqual([a.reason, a.error, a.plan], ['message_error', 'ConnectionRefused', { done: 3, total: 8 }]);
  assert.deepEqual(report.totals, { sessions: 2, finished: 1, unfinished: 1, working: 0, workedMs: 6 * HOUR + 35 * MIN, waitedMs: 4 * HOUR + 25 * MIN, stillMs: 4 * HOUR + 25 * MIN, longestStill: { from: NIGHT + 5 * HOUR + 35 * MIN, to: end, ms: 4 * HOUR + 25 * MIN } });

  const lines = overnightLines(report, t);
  assert.equal(lines.length, 3);
  assert.match(lines[1], /overnight\.still .*"span":"4 h 25 min","from":"03:35","to":"08:00"/);
  // The error text can hold a path: only with includeDetail.
  assert.ok(!lines[2].includes('ConnectionRefused'));
  assert.ok(overnightLines(report, t, { includeDetail: true })[2].includes('ConnectionRefused'));
});

test('a quiet night says so', () => {
  const report = overnightOf({ from: NIGHT, to: NIGHT + 10 * HOUR, before: new Map([['c', event('c', NIGHT - HOUR, 'finished')]]), events: [] });
  assert.equal(report.totals.sessions, 0);
  assert.deepEqual(overnightLines(report, t), ['overnight.none']);
});

test('the morning message goes to Discord once, at the end of the night, and only when switched on', () => {
  const history = createHistory({ file: null, retentionDays: 30 });
  history.record([{ id: 'a', title: 'Task a', project: 'shop', state: 'working', since: NIGHT + HOUR }], NIGHT + HOUR);
  history.record([{ id: 'a', title: 'Task a', project: 'shop', state: 'finished', reason: 'done', since: NIGHT + 2 * HOUR }], NIGHT + 2 * HOUR);
  const sent = [];
  const cfg = on => ({ overnight: { from: 22, to: 8 }, history: { enabled: true }, notify: { overnight: { enabled: on }, discord: { webhookUrl: 'https://discord.com/api/webhooks/1/x', includeDetail: false } } });
  const make = on => createOvernight({ cfg: cfg(on), history, tasks: () => ({ projects: [] }), send: (...args) => sent.push(args), t });
  const at8 = NIGHT + 10 * HOUR;
  assert.equal(make(false).check(at8 + MIN), false);
  const overnight = make(true);
  assert.equal(overnight.check(at8 - MIN), false);
  assert.equal(overnight.check(at8 + MIN), true);
  assert.equal(overnight.check(at8 + 3 * MIN), false);
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], 'overnight');
  assert.match(sent[0][2][0], /overnight\.summary .*"n":1/);
  assert.equal(overnight.report(at8 + MIN).totals.workedMs, HOUR);
});

test('the longest stretch nothing ran, not short stops added up', () => {
  const report = overnightOf({
    from: NIGHT,
    to: NIGHT + 10 * HOUR,
    before: new Map(),
    events: [
      event('a', NIGHT + HOUR, 'working'),
      event('a', NIGHT + 2 * HOUR, 'stuck'),
      event('a', NIGHT + 2 * HOUR + 5 * MIN, 'working'),
      event('a', NIGHT + 3 * HOUR, 'waiting', { reason: 'question' }),
      event('a', NIGHT + 9 * HOUR, 'working'),
    ],
  });
  assert.equal(report.totals.stillMs, 6 * HOUR + 5 * MIN);
  assert.deepEqual(report.totals.longestStill, { from: NIGHT + 3 * HOUR, to: NIGHT + 9 * HOUR, ms: 6 * HOUR });
  // Working again when the night ended: neither finished nor waiting.
  assert.deepEqual([report.totals.working, report.totals.unfinished, report.totals.finished], [1, 0, 0]);
});
