// Prompt cache lost, and why, from the cached and new tokens OpenCode records per request.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cacheDropsOf } from '../src/cache-drops.mjs';
import { takeawaysOf } from '../src/takeaways.mjs';

const MIN = 60_000;
const T = new Date(2026, 9, 17, 10, 0).getTime();
let n = 0;
// A request: what it read anew, what came from the cache, and how it ended.
const req = (session, at, input, cached, extra = {}) => ({
  id: `m${n++}`, session_id: session, role: 'assistant', provider_id: 'local-llama', model_id: 'qwen', agent: 'build',
  time_created: at, completed: at + 30_000, tokens_input: input, tokens_cache_read: cached, tokens_cache_write: 0, finish: 'tool-calls', ...extra,
});
const drops = (messages, extra = {}) => cacheDropsOf(messages, { from: T - 60 * MIN, to: T + 600 * MIN, ...extra });

test('a cache that held is no loss; one lost at a new turn is said so', () => {
  // As on this machine at 11:02: the turn ended (stop), 56 s later the next began from nothing.
  const messages = [
    req('s', T, 1902, 85667, { finish: 'stop' }),
    req('s', T + 86_000, 87009, 0),
    req('s', T + 3 * MIN, 243, 87251),
  ];
  const d = drops(messages);
  assert.equal(d.count, 1);
  assert.deepEqual(d.byCause, { new_turn: { count: 1, tokens: 87009, ms: 0 } });
  assert.deepEqual([d.unexpected.count, d.unexpected.tokens], [1, 87009]);
});

test('the start held and the rest changed: part of the prompt was rewritten', () => {
  // As at 11:09: 80,725 of 92,756 still cached, 10,624 read again.
  const d = drops([req('s', T, 1422, 91334), req('s', T + MIN, 10624, 80725)]);
  assert.deepEqual(Object.keys(d.byCause), ['prefix_changed']);
  assert.equal(d.tokens, 10624);
});

test('expected losses: after a compaction, and with another model', () => {
  const d = drops([
    req('s', T, 500, 90000),
    req('s', T + MIN, 90000, 0, { agent: 'compaction' }),
    req('s', T + 2 * MIN, 9000, 0),
    req('s', T + 3 * MIN, 200, 9000),
    req('s', T + 4 * MIN, 9200, 0, { model_id: 'bonsai' }),
    // Its server reports cached tokens too.
    req('s', T + 5 * MIN, 100, 9200, { model_id: 'bonsai' }),
  ]);
  assert.deepEqual(Object.keys(d.byCause).sort(), ['compaction', 'model_changed']);
  assert.equal(d.unexpected.count, 0);
});

test('another session in between, or a long pause', () => {
  const d = drops([
    req('a', T, 500, 60000),
    req('b', T + MIN, 40000, 0),
    req('a', T + 2 * MIN, 60500, 0),
    req('a', T + 30 * MIN, 61000, 0),
  ]);
  assert.deepEqual(Object.fromEntries(Object.entries(d.byCause).map(([c, v]) => [c, v.count])), { other_session: 1, pause: 1 });
});

test('a server that never reports cached tokens is not counted: every request would look like a loss', () => {
  const d = drops([req('s', T, 60000, 0), req('s', T + MIN, 61000, 0), req('s', T + 2 * MIN, 62000, 0)]);
  assert.deepEqual([d.checked, d.count], [0, 0]);
});

test('only the sessions in scope, and only requests inside the period', () => {
  const messages = [req('a', T, 1902, 85667, { finish: 'stop' }), req('a', T + MIN, 87009, 0), req('b', T, 1902, 85667, { finish: 'stop' }), req('b', T + MIN, 87009, 0)];
  assert.equal(drops(messages, { inScope: id => id === 'b' }).count, 1);
  assert.equal(cacheDropsOf(messages, { from: T + 2 * MIN, to: T + 600 * MIN }).checked, 0);
});

test('the time is at the speed the model reads prompts here', () => {
  const d = drops([req('s', T, 1902, 85667, { finish: 'stop' }), req('s', T + MIN, 87009, 0)], { readTps: () => 500 });
  assert.equal(d.byCause.new_turn.ms, Math.round((87009 / 500) * 1000));
});

test('a takeaway from three unexpected losses and 200k tokens on, by the cause that cost most', () => {
  const base = { totals: { sessions: 1 }, usage: {}, tools: [], mcp: [], work: { time: { readingMs: 0, thinkingMs: 0, writingMs: 0, toolMs: 0 }, turns: { ended: { cut: 0 }, cut: [] }, permissions: { asked: 0, top: [] }, plans: { total: 0, dropped: 0 } } };
  const stats = (count, tokens) => ({ ...base, cacheDrops: { checked: 100, count, tokens, unexpected: { count, tokens, ms: 0 }, byCause: { new_turn: { count, tokens, ms: 30 * MIN }, compaction: { count: 50, tokens: 5_000_000, ms: 0 } } } });
  assert.ok(!takeawaysOf(stats(2, 400_000)).some(t => t.id.startsWith('cache_lost')));
  assert.ok(!takeawaysOf(stats(5, 100_000)).some(t => t.id.startsWith('cache_lost')));
  assert.deepEqual(takeawaysOf(stats(5, 400_000)).find(t => t.id.startsWith('cache_lost')), { id: 'cache_lost_new_turn', tone: 'act', vars: { n: 5, tokens: 400, minutes: 30 }, anchor: 'stats-model' });
});
