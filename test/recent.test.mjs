// Rate takeaways from the figures since the newest change of the config or the model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modelSwitchAt, recentOf } from '../src/recent.mjs';
import { computeStats } from '../src/stats.mjs';
import { takeawaysOf, shortTime } from '../src/takeaways.mjs';

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = new Date(2026, 9, 8, 12, 0, 0).getTime();
const show = text => String(text ?? '');

const reply = (id, start, end, extra = {}) => ({
  id, session_id: 's1', role: 'assistant', time_created: start, completed: end, provider_id: 'a', model_id: 'x', agent: 'build', ...extra,
});
const call = (id, tool, t, status, extra = {}) => ({
  id, session_id: 's1', tool, status, started: t, ended: t + 1000, time_created: t, time_updated: t + 1000, ...extra,
});

function rows({ failingUntil, changeAt }) {
  const tools = [];
  // 40 calls a day for four days; half failed until the fix, one in forty after it.
  for (let i = 0; i < 160; i++) {
    const t = NOW - 4 * 24 * HOUR + i * 36 * MIN;
    tools.push(call(`t${i}`, 'chrome_evaluate', t, t < failingUntil ? (i % 2 === 0 ? 'error' : 'completed') : (i % 40 === 0 ? 'error' : 'completed')));
  }
  return {
    sessions: [{ id: 's1', parent_id: null, directory: '/work/shop', title: 'Shop', time_created: NOW - 5 * 24 * HOUR }],
    tools,
    messages: [reply('m1', NOW - 4 * 24 * HOUR, changeAt - MIN), reply('m2', changeAt, NOW - MIN)],
    compactions: [], asks: [], replies: new Map(), eventTimes: new Map(), now: NOW, days: 7, stuckMs: 10 * MIN, show,
  };
}

test('the model in use now took over at its first reply after the last of another', () => {
  const sessions = [{ id: 's1', parent_id: null }, { id: 'sub', parent_id: 's1' }];
  const messages = [
    reply('1', 1000, 2000, { model_id: 'y' }),
    reply('2', 3000, 4000),
    reply('3', 5000, 6000, { model_id: 'y' }),
    reply('4', 7000, 8000),
    reply('5', 7500, 9000),
    // A subagent on another model is not a change.
    reply('6', 8500, 8600, { session_id: 'sub', model_id: 'small' }),
  ];
  assert.equal(modelSwitchAt(messages, sessions), 7000);
  assert.equal(modelSwitchAt(messages.filter(m => m.model_id === 'x'), sessions), null);
});

test('a failure rate fixed by a change is said as fixed, not as failing', () => {
  const changeAt = NOW - 2 * 24 * HOUR;
  const input = rows({ failingUntil: changeAt, changeAt });
  const whole = computeStats(input);
  // Over the whole period it still reads as failing.
  assert.ok(takeawaysOf(whole).some(t => t.id === 'tool_failures'));
  const recent = recentOf(input, whole, [changeAt]);
  assert.equal(recent.why, 'config');
  const ids = takeawaysOf(whole, recent);
  assert.ok(!ids.some(t => t.id === 'tool_failures'));
  const better = ids.find(t => t.id === 'tool_failures_better');
  assert.deepEqual(better.vars, { tool: 'chrome_evaluate', was: 26, pct: 3, n: 2, calls: 80, since: shortTime(changeAt) });
});

test('a rate still bad since the change says so from then', () => {
  const changeAt = NOW - 2 * 24 * HOUR;
  const input = rows({ failingUntil: NOW, changeAt });
  const whole = computeStats(input);
  const t = takeawaysOf(whole, recentOf(input, whole, [changeAt])).find(x => x.id === 'tool_failures');
  assert.equal(t.since, changeAt);
  assert.equal(t.vars.since, shortTime(changeAt));
});

test('too little since the change: the whole period is read, as before', () => {
  const changeAt = NOW - 20 * MIN;
  const input = rows({ failingUntil: NOW, changeAt });
  const whole = computeStats(input);
  assert.equal(recentOf(input, whole, [changeAt]), null);
});

test('a script that looped is its own line and out of the failure rate', () => {
  const input = rows({ failingUntil: 0, changeAt: NOW - 3 * 24 * HOUR });
  for (let i = 0; i < 60; i++) input.tools.push(call(`loop${i}`, 'chrome_evaluate', NOW - HOUR + i, 'error', { script: 'x1', script_calls: 60 }));
  const whole = computeStats(input);
  const ids = takeawaysOf(whole);
  assert.ok(!ids.some(t => t.id === 'tool_failures'));
  assert.deepEqual(ids.find(t => t.id === 'script_loop').vars, { tool: 'chrome_evaluate', scripts: 1, calls: 60, n: 60 });
});

test('a change with too little after it gives way to the one before it', () => {
  const fixed = NOW - 2 * 24 * HOUR;
  const input = rows({ failingUntil: fixed, changeAt: fixed });
  const whole = computeStats(input);
  assert.equal(recentOf(input, whole, [fixed, NOW - 20 * MIN]).since, fixed);
});
