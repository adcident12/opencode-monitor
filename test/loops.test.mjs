// The agent going round in circles: the same calls, one tool failing, its plan not moving.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loopsOf, loopsInPeriod, LIMITS } from '../src/loops.mjs';
import { deriveHealth } from '../src/state.mjs';
import { createNotifier } from '../src/notify.mjs';
import { takeawaysOf } from '../src/takeaways.mjs';
import { DEFAULTS } from '../src/config.mjs';

const MIN = 60_000;
const T = Date.parse('2026-10-17T09:00:00Z');
let n = 0;
const call = (tool, input = '{}', extra = {}) => ({ id: `p${n++}`, type: 'tool', tool, input, input_len: input.length, status: 'completed', time_created: T + n * 10_000, ...extra });
const times = (k, make) => Array.from({ length: k }, make);
const plan = (...statuses) => call('todowrite', '{}', { todos: JSON.stringify(statuses.map((status, i) => ({ content: `step ${i}`, status }))) });

test('the same call back to back: told from the eighth, not before', () => {
  const snap = () => call('take_snapshot', '{"pageId":2}');
  assert.equal(loopsOf(times(7, snap)).episodes.length, 0);
  const { episodes, now } = loopsOf([call('read'), ...times(12, snap)]);
  assert.equal(episodes.length, 1);
  assert.deepEqual([episodes[0].kind, episodes[0].times, episodes[0].tools], ['repeating', 12, ['take_snapshot']]);
  assert.equal(now, episodes[0]);
  // Something else after it: no longer going on.
  assert.equal(loopsOf([...times(9, snap), call('edit')]).now, null);
});

test('two calls in turn, six times; a different input is not the same call', () => {
  const pair = i => [call('click', '{"uid":"1_44"}'), call('take_snapshot', '{"pageId":1}')][i % 2];
  assert.equal(loopsOf(times(10, (_, i) => pair(i))).episodes.length, 0);
  const { episodes } = loopsOf(times(12, (_, i) => pair(i)));
  assert.deepEqual([episodes[0].kind, episodes[0].times], ['repeating', 6]);
  assert.equal(loopsOf(times(10, (_, i) => call('read', `{"filePath":"f${i}"}`))).episodes.length, 0);
});

test('one tool failing again and again, whatever ran between; a success ends it', () => {
  const fail = () => call('wait_for', '{"text":"Done"}', { status: 'error', error: 'Timed out' });
  const calls = [fail(), call('take_snapshot'), fail(), call('take_snapshot'), fail(), fail()];
  const { episodes, now } = loopsOf(calls);
  assert.deepEqual([episodes[0].kind, episodes[0].tool, episodes[0].times, episodes[0].error], ['failing', 'wait_for', 4, 'Timed out']);
  assert.equal(now, episodes[0]);
  assert.equal(loopsOf([fail(), fail(), fail(), call('wait_for'), fail()]).episodes.length, 0);
  // Given up on, and other work done since: not going on.
  assert.equal(loopsOf([...calls, ...times(LIMITS.failingRecent, () => call('read'))]).now, null);
});

test('one call failing over and over is told once, as failing', () => {
  const { episodes } = loopsOf(times(30, () => call('evaluate_script', '{"function":"x"}', { status: 'error' })));
  assert.deepEqual(episodes.map(e => [e.kind, e.times]), [['failing', 30]]);
});

test('an hour of work and thirty calls with the plan not moving; a change or a done plan resets it', () => {
  // A call every two minutes: 31 calls is an hour.
  const work = k => times(k, () => call('read', `{"filePath":"f${n}"}`, { time_created: T + n * 2 * MIN }));
  const stalled = loopsOf([plan('in_progress', 'pending'), ...work(32)]);
  assert.deepEqual([stalled.episodes[0]?.kind, stalled.episodes[0]?.open], ['plan_stalled', 2]);
  assert.equal(stalled.now, stalled.episodes[0]);
  assert.equal(loopsOf([plan('in_progress'), ...work(20), plan('completed', 'in_progress'), ...work(20)]).episodes.length, 0);
  assert.equal(loopsOf([plan('completed', 'completed'), ...work(40)]).episodes.length, 0);
  // A long pause counts as ten minutes of work, no more.
  const paused = [plan('in_progress'), call('read', '{}', { time_created: T + 900 * MIN }), ...times(5, () => call('read', `{"n":${n}}`, { time_created: T + 900 * MIN + n }))];
  assert.equal(loopsOf(paused).episodes.length, 0);
});

test('a period: plans from the lists written, sessions in scope, still going only when recent', () => {
  const now = T + 100 * MIN;
  const tools = times(9, () => ({ ...call('take_snapshot', '{"pageId":1}'), session_id: 'a' }));
  tools.push(...times(9, () => ({ ...call('take_snapshot', '{"pageId":1}'), session_id: 'b' })));
  const r = loopsInPeriod({ tools, todoWrites: [], from: T, now });
  assert.deepEqual([r.count, r.byKind], [2, { repeating: 2 }]);
  assert.ok(r.episodes.every(e => !e.ongoing));
  assert.ok(loopsInPeriod({ tools, todoWrites: [], from: T, now: T + 5 * MIN }).episodes.every(e => e.ongoing));
  assert.equal(loopsInPeriod({ tools, todoWrites: [], from: T, now, inScope: id => id === 'a' }).count, 1);
  assert.equal(loopsInPeriod({ tools, todoWrites: [], from: now, now }).count, 0);
  const todoWrites = [{ session_id: 'c', time_created: T, todos: JSON.stringify([{ content: 'x', status: 'pending' }]) }];
  const work = times(40, (_, i) => ({ id: `w${i}`, session_id: 'c', tool: 'read', input: `{"n":${i}}`, status: 'completed', time_created: T + (i + 1) * 2 * MIN }));
  assert.deepEqual(loopsInPeriod({ tools: work, todoWrites, from: T, now }).byKind, { plan_stalled: 1 });
});

test('the session says so in its hints, in place of the softer "ran a few times lately"', () => {
  const parts = times(10, () => call('read', '{"filePath":"a.ts"}'));
  const h = deriveHealth({ session: { time_created: T }, parts, now: T + 10 * MIN, thresholds: DEFAULTS.thresholds, contextLimit: null });
  assert.equal(h.loop.kind, 'repeating');
  assert.equal(h.loop.times, 10);
  assert.ok(h.hints.includes('loop'));
  assert.ok(!h.hints.includes('looping'));
});

test('told once per episode, while at work, for a subagent too; not what was so at startup', () => {
  const sent = [];
  const notify = createNotifier(
    { on: ['loop'], repeatMinutes: 30, desktop: true, discord: { webhookUrl: '', mention: '', includeDetail: false } },
    (key, vars = {}) => `${key}${vars.n ? ` ${vars.n}` : ''}`,
    { desktop: (title, body) => sent.push(`${title} | ${body}`), discord: () => {} },
  );
  const session = (loop, extra = {}) => ({ id: 's1', parentId: null, state: 'working', since: 0, project: 'shop', title: 'Checkout', health: { hints: [], loop }, ...extra });
  const failing = id => ({ kind: 'failing', id, tool: 'wait_for', times: 4 });
  notify([session(failing('a'))], 1);
  notify([session(failing('a'))], 2);
  assert.equal(sent.length, 0);
  notify([session(failing('b'))], 3);
  notify([session(failing('b'))], 4);
  assert.deepEqual(sent, ['notify.loop.failing | shop — Checkout · notify.loop.failing.body 4']);
  notify([session(failing('c'), { state: 'idle' })], 5);
  assert.equal(sent.length, 1);
  notify([session(null), session(failing('d'), { id: 'child', parentId: 's1' })], 6);
  assert.equal(sent.length, 2);
});

test('a takeaway from three loops, or one long one, named by the worst', () => {
  const base = { totals: { sessions: 1 }, usage: {}, tools: [], mcp: [], work: { time: { readingMs: 0, thinkingMs: 0, writingMs: 0, toolMs: 0 }, turns: { ended: { cut: 0 }, cut: [] }, permissions: { asked: 0, top: [] }, plans: { total: 0, dropped: 0 } } };
  const ep = (kind, extra) => ({ kind, tool: null, tools: null, times: null, workMs: null, ...extra });
  const of = episodes => takeawaysOf({ ...base, loops: { count: episodes.length, byKind: {}, episodes } }).find(t => t.id.startsWith('loops_'));
  assert.equal(of([ep('failing', { tool: 'wait_for', times: 4 })]), undefined);
  assert.deepEqual(of([ep('failing', { tool: 'evaluate_script', times: 257 })]), { id: 'loops_failing', tone: 'act', vars: { n: 1, tool: 'evaluate_script', times: 257, hours: 0 }, anchor: 'stats-agent' });
  assert.equal(of([ep('failing', { tool: 'a', times: 4 }), ep('repeating', { tools: ['b'], times: 9 }), ep('plan_stalled', { workMs: 3_600_000 })]).id, 'loops_repeating');
  assert.equal(of([ep('plan_stalled', { workMs: 3 * 3_600_000 })]).vars.hours, 3);
});

test('an OpenCode 2 script is one turn: each tool in it counts once, failed when all its calls failed', () => {
  const inScript = (script, tool, status) => call(tool, '{"function":"x"}', { script, status });
  // One script that called the same failing tool 30 times: the script's loop, not the agent's.
  assert.equal(loopsOf(times(30, () => inScript('s1', 'evaluate_script', 'error'))).episodes.length, 0);
  // A tool that fails script after script is the agent trying again and again.
  const scripts = times(4, (_, i) => [inScript(`w${i}`, 'wait_for', 'error'), inScript(`w${i}`, 'take_snapshot', 'completed')]).flat();
  assert.deepEqual(loopsOf(scripts).episodes.map(e => [e.kind, e.tool, e.times]), [['failing', 'wait_for', 4]]);
  // A script where the tool worked once is not a failure of it.
  const mixed = times(4, (_, i) => [inScript(`m${i}`, 'wait_for', 'error'), inScript(`m${i}`, 'wait_for', 'completed')]).flat();
  assert.equal(loopsOf(mixed).episodes.length, 0);
});
