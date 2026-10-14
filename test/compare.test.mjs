// Before and after a moment, per hour of agent time; and the figures added with it: reply
// lengths per model, time spent compacting, the models of each session.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareAt } from '../src/compare.mjs';
import { computeStats } from '../src/stats.mjs';
import { takeawaysOf } from '../src/takeaways.mjs';
import { bufferNote } from '../src/mcp-server.mjs';

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = new Date(2026, 9, 8, 12, 0, 0).getTime();
const AT = NOW - 10 * HOUR;
const show = text => String(text ?? '');

const reply = (id, start, end, extra = {}) => ({
  id, session_id: 's1', role: 'assistant', time_created: start, completed: end, provider_id: 'a', model_id: 'x', agent: 'build', error_name: null, ...extra,
});
const call = (id, tool, start, end, extra = {}) => ({
  id, session_id: 's1', tool, status: 'completed', started: start, ended: end, time_created: start, time_updated: end, ...extra,
});
const input = extra => ({
  sessions: [{ id: 's1', parent_id: null, directory: '/work/shop', title: 'Shop', time_created: AT - 6 * HOUR }],
  messages: [], tools: [], compactions: [], spans: [], asks: [], replies: new Map(), eventTimes: new Map(), now: NOW, ...extra,
});

function day() {
  return input({
    messages: [
      reply('m1', AT - 5 * HOUR, AT - 2 * HOUR),
      reply('c1', AT - 2 * HOUR, AT - 2 * HOUR + 10 * MIN, { agent: 'compaction' }),
      reply('m2', AT + HOUR, AT + 3 * HOUR),
      reply('m3', AT + 3 * HOUR, AT + 3 * HOUR + MIN, { error_name: 'MessageAbortedError' }),
    ],
    compactions: [{ session_id: 's1', time_created: AT - 2 * HOUR }],
    tools: [
      call('r1', 'read', AT - 4 * HOUR, AT - 4 * HOUR + 100, { file: '/work/shop/a.js', input: '{}' }),
      // Read again, whole, after the compaction, then edited: the read was for changing it.
      call('r2', 'read', AT - HOUR, AT - HOUR + 100, { file: '/work/shop/a.js', input: '{"filePath":"a.js"}' }),
      call('e1', 'edit', AT - HOUR + MIN, AT - HOUR + MIN + 100, { file: '/work/shop/a.js' }),
      call('b1', 'bash', AT + HOUR, AT + HOUR + 3 * MIN),
      call('r3', 'read', AT + 2 * HOUR, AT + 2 * HOUR + 100, { file: '/work/shop/b.js', status: 'error' }),
    ],
    spans: [{ session_id: 's1', type: 'reasoning', s: AT + HOUR, e: AT + HOUR + 30 * MIN }],
  });
}

test('each side per hour of its own agent time, cut to the data there is', () => {
  const c = compareAt(day(), AT, 24);
  // The first reply is 5 hours before; now is 10 hours after.
  assert.deepEqual([c.hoursBefore, c.hoursAfter], [5, 10]);
  assert.equal(c.reliable, true);
  assert.equal(c.before.agentHours, 3.17);
  assert.deepEqual(c.before.compactions, { count: 1, perHour: 0.32, averageMs: 10 * MIN });
  assert.deepEqual(c.before.rereadsAfterCompaction, { total: 1, whole: 1, ranged: 0, thenEdited: 1 });
  assert.equal(c.after.compactions.count, 0);
  assert.equal(c.after.longCalls.count, 1);
  assert.equal(c.after.interrupted.count, 1);
  assert.equal(c.after.thinkingPct, 25);
  assert.deepEqual(c.after.toolFailures.find(t => t.tool === 'read'), { tool: 'read', calls: 1, failed: 1, pct: 100 });
  assert.deepEqual(c.after.models, [{ model: 'a/x', replies: 2 }]);
});

test('a different model on one side makes the comparison unreliable, and says why', () => {
  const rows = day();
  rows.messages[2].model_id = 'y';
  rows.messages[3].model_id = 'y';
  const c = compareAt(rows, AT, 24);
  assert.equal(c.reliable, false);
  assert.match(c.note, /model was not the same/);
});

test('a range read after the compaction counts as ranged; another session is out of scope', () => {
  const rows = day();
  rows.tools[1].input = '{"filePath":"a.js","offset":40,"limit":20}';
  assert.deepEqual(compareAt(rows, AT, 24).before.rereadsAfterCompaction, { total: 1, whole: 0, ranged: 1, thenEdited: 1 });
  assert.equal(compareAt(rows, AT, 24, new Set(['other'])).before.agentHours, 0);
});

test('no time on one side is said, not shown as zeros; too little time comes before the model', () => {
  assert.ok(compareAt(day(), NOW, 24).error);
  const c = compareAt(day(), AT - 4 * HOUR - 30 * MIN, 24);
  assert.equal(c.reliable, false);
  assert.match(c.note, /too little/);
});

const stats = extra => computeStats({
  sessions: [{ id: 's1', parent_id: null, directory: '/work/shop', title: 'Shop', time_created: NOW - 30 * HOUR }],
  tools: [call('t1', 'read', NOW - 2 * HOUR, NOW - 2 * HOUR + 100, { file: '/work/shop/a.js' })],
  compactions: [], asks: [], replies: new Map(), eventTimes: new Map(), now: NOW, days: 7, stuckMs: 10 * MIN, show, ...extra,
});

test('reply lengths per model, thinking included, from every reply with a count', () => {
  const messages = Array.from({ length: 100 }, (_, i) => reply(`m${i}`, NOW - 3 * HOUR + i * MIN, NOW - 3 * HOUR + i * MIN + 1000, { tokens_output: i + 1, tokens_reasoning: 1 }));
  // One timed reply puts the model in the speed list; the lengths come from all of them.
  const s = stats({ messages, steps: new Map([['m0', { first_token: messages[0].time_created + 100, written: messages[0].time_created + 900 }]]) });
  assert.deepEqual(s.speed.models.find(m => m.model === 'a/x').output, { replies: 100, p50: 52, p95: 97, p99: 101, max: 101 });
});

test('time spent compacting, and the models of each session', () => {
  const s = stats({
    messages: [
      reply('m1', NOW - 3 * HOUR, NOW - 2 * HOUR),
      reply('c1', NOW - 2 * HOUR, NOW - 2 * HOUR + 20 * MIN, { agent: 'compaction', model_id: 'z' }),
      reply('m2', NOW - HOUR, NOW - HOUR + MIN, { model_id: 'y' }),
    ],
  });
  assert.equal(s.totals.compactingMs, 20 * MIN);
  assert.equal(s.sessions[0].compactingMs, 20 * MIN);
  // The model that summarised is not one that did the work.
  assert.deepEqual(s.sessions[0].models, [{ model: 'a/x', replies: 1 }, { model: 'a/y', replies: 1 }]);
});

test('compacting time and a long session are takeaways only past their thresholds', () => {
  const s = stats({ messages: [] });
  const ids = () => takeawaysOf(s).map(t => t.id);
  s.totals = { ...s.totals, compactingMs: 40 * MIN, activeMs: 3 * HOUR, compactions: 12 };
  assert.ok(ids().includes('compacting_time'));
  s.totals.activeMs = 10 * HOUR;
  assert.ok(!ids().includes('compacting_time'));
  s.sessions = [{ id: 's1', compactions: 19, activeMs: 9 * HOUR }];
  assert.ok(!ids().includes('long_session'));
  s.sessions[0].compactions = 25;
  assert.deepEqual(takeawaysOf(s).find(t => t.id === 'long_session').vars, { n: 25, hours: 9 });
  // With another session picked, this one is not spoken of.
  s.session = { id: 's2' };
  assert.ok(!ids().includes('long_session'));
});

test('the buffer note speaks only when the replies say something', () => {
  assert.equal(bufferNote({ replies: 500, p99: 9000, max: 15074 }, 24576), null);
  assert.match(bufferNote({ replies: 500, p99: 9000, max: 26000 }, 24576), /larger buffer/);
  assert.match(bufferNote({ replies: 500, p99: 4000, max: 6000 }, 24576), /smaller buffer/);
  assert.equal(bufferNote({ replies: 50, p99: 4000, max: 6000 }, 24576), null);
});
