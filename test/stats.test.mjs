import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeStats, dayKey } from '../src/stats.mjs';

const MIN = 60_000;
const HOUR = 60 * MIN;
// A fixed local noon, so the day buckets do not depend on when the test runs.
const NOW = new Date(2026, 9, 8, 12, 0, 0).getTime();
const show = text => String(text ?? '');

const tool = (id, session, tool, start, end, extra = {}) => ({
  id, session_id: session, tool, status: end == null ? 'running' : 'completed', started: start, ended: end,
  time_created: start, time_updated: end ?? start, ...extra,
});
const run = input => computeStats({
  sessions: [{ id: 's1', parent_id: null, directory: '/work/shop', title: 'Shop', time_created: NOW - 30 * HOUR }],
  tools: [], messages: [], compactions: [], asks: [], replies: new Map(), eventTimes: new Map(),
  now: NOW, days: 7, stuckMs: 10 * MIN, show, ...input,
});

test('a permission prompt waits until the call it blocked is next updated', () => {
  const askAt = NOW - 9 * HOUR;
  const s = run({
    tools: [tool('p1', 's1', 'read', askAt - 1, askAt + 8 * HOUR + 10 * MIN + 2000, { file: '/work/shop/.env' })],
    asks: [{ t: askAt, run: 'r1', kind: 'permission', permission: 'read', patterns: '/work/shop/.env' }],
    // Drawn at +2ms (ignored), approved after 8h10m.
    eventTimes: new Map([['p1', [askAt + 2, askAt + 8 * HOUR + 10 * MIN]]]),
    liveRuns: new Set(['r1']),
  });
  assert.equal(s.totals.prompts, 1);
  assert.equal(s.waits[0].waitMs, 8 * HOUR + 10 * MIN);
  assert.deepEqual([s.waits[0].answered, s.waits[0].abandoned, s.waits[0].project], [true, false, 'shop']);
  assert.equal(s.daily.find(d => d.date === dayKey(askAt)).waitMs, 8 * HOUR + 10 * MIN);
  // The time spent waiting for permission is not counted as the command being slow.
  assert.equal(s.slow[0].runMs, 2001);
});

test('a question waits until its logged reply', () => {
  const askAt = NOW - 2 * HOUR;
  const s = run({
    tools: [tool('q1', 's1', 'question', askAt, askAt + 5 * MIN, { question: 'Which library?' })],
    asks: [{ t: askAt, id: 'que_1', run: 'r1', kind: 'question', permission: null, patterns: '' }],
    replies: new Map([['que_1', askAt + 4 * MIN]]),
    liveRuns: new Set(['r1']),
  });
  assert.equal(s.waits[0].waitMs, 4 * MIN);
  assert.equal(s.totals.medianAnswerMs, 4 * MIN);
});

test('prompts and calls left behind by a crash are not counted as hours of waiting or running', () => {
  const askAt = NOW - 5 * 24 * HOUR;
  const s = run({
    tools: [
      tool('dead', 's1', 'read', askAt, null),
      tool('left', 's1', 'write', askAt + HOUR, null),
    ],
    asks: [{ t: askAt, run: 'old-process', kind: 'permission', permission: 'read', patterns: 'x' }],
    // The process that asked wrote its last line 20 minutes later and is gone.
    runEnds: new Map([['old-process', askAt + 20 * MIN]]),
    liveRuns: new Set(['new-process']),
    // The session went on with a new message after the write was left running.
    messages: [{ session_id: 's1', role: 'user', time_created: askAt + 2 * HOUR, completed: null }],
  });
  assert.deepEqual([s.totals.open, s.totals.abandoned, s.waits[0].waitMs], [0, 1, 20 * MIN]);
  assert.equal(s.totals.abandonedCalls, 2);
  assert.equal(s.slow.length, 0, 'abandoned calls are not "slow"');
  assert.equal(s.totals.stuck, 0);
});

test('a prompt that is still waiting right now stays open', () => {
  const askAt = NOW - 30 * MIN;
  const s = run({
    tools: [tool('p1', 's1', 'bash', askAt, null, { cmd: 'npm outdated' })],
    asks: [{ t: askAt, run: 'r1', kind: 'permission', permission: 'bash', patterns: 'npm outdated' }],
    liveRuns: new Set(['r1']),
  });
  assert.deepEqual([s.totals.open, s.waits[0].waitMs, s.waits[0].answered], [1, 30 * MIN, false]);
});

test('tool use: counts, errors, stuck calls, graft against plain search, re-reads, skills', () => {
  const t = NOW - 3 * HOUR;
  const s = run({
    tools: [
      tool('a', 's1', 'bash', t, t + 35 * MIN, { cmd: 'npm run dev' }),
      tool('b', 's1', 'bash', t, t + 1000, { cmd: 'npm test', status: 'error' }),
      ...[1, 2, 3, 4].map(i => tool(`r${i}`, 's1', 'read', t + i, t + i + 10, { file: '/work/shop/a.ts' })),
      tool('g', 's1', 'grep', t, t + 10),
      tool('gf', 's1', 'graft_graft_find_code', t, t + 10),
      tool('sk', 's1', 'skill', t, t + 10, { skill: 'tdd' }),
    ],
    compactions: [{ session_id: 's1', time_created: t }],
  });
  assert.deepEqual(s.tools.slice(0, 2).map(x => [x.tool, x.count, x.errors]), [['read', 4, 0], ['bash', 2, 1]]);
  assert.equal(s.totals.stuck, 1);
  assert.deepEqual(s.slow[0], { at: t, tool: 'bash', text: 'npm run dev', runMs: 35 * MIN, status: 'completed', running: false, project: 'shop', title: 'Shop' });
  assert.deepEqual(s.explore, { graft: 1, other: 5 });
  assert.deepEqual(s.rereads, [{ file: '/work/shop/a.ts', count: 4, project: 'shop', title: 'Shop' }]);
  assert.deepEqual(s.skills, [{ name: 'tdd', count: 1 }]);
  assert.equal(s.totals.compactions, 1);
});

test('days: one bucket per calendar day, oldest first, agent time clipped to the range', () => {
  const s = run({
    days: 7,
    messages: [
      { session_id: 's1', role: 'assistant', time_created: NOW - HOUR, completed: NOW - 30 * MIN },
      { session_id: 's1', role: 'assistant', time_created: NOW - 30 * 24 * HOUR, completed: NOW - 30 * 24 * HOUR + HOUR },
    ],
  });
  assert.equal(s.daily.length, 7);
  assert.equal(s.daily.at(-1).date, dayKey(NOW));
  assert.equal(s.daily.at(-1).activeMs, 30 * MIN);
  assert.equal(s.totals.activeMs, 30 * MIN, 'a reply from a month ago is outside the range');
});

test('one session: its own calls, prompts and subagents, and nothing from the others', () => {
  const at = NOW - 3 * HOUR;
  const s = run({
    sessions: [
      { id: 's1', parent_id: null, directory: '/work/shop', title: 'Shop', time_created: NOW - 30 * HOUR },
      { id: 's1-sub', parent_id: 's1', directory: '/work/shop', title: 'Explore', time_created: NOW - 4 * HOUR },
      { id: 's2', parent_id: null, directory: '/work/blog', title: 'Blog', time_created: NOW - 30 * HOUR },
    ],
    tools: [
      tool('a', 's1', 'bash', at, at + MIN),
      tool('b', 's1-sub', 'graft_find_code', at + MIN, at + 2 * MIN),
      tool('c', 's2', 'bash', at + 10 * MIN, at + 11 * MIN),
      tool('d', 's2', 'graft_find_code', at + 20 * MIN, at + 21 * MIN, { status: 'error', error: 'MCP error -32000: Connection closed' }),
    ],
    messages: [
      { session_id: 's1', role: 'assistant', time_created: at, completed: at + 5 * MIN },
      { session_id: 's2', role: 'assistant', time_created: at, completed: at + 30 * MIN },
    ],
    compactions: [{ session_id: 's2', time_created: at }],
    asks: [{ t: at + 10 * MIN, run: 'r1', kind: 'permission', permission: 'bash', patterns: 'npm test' }],
    liveRuns: new Set(['r1']),
    sessionId: 's1',
    mcp: { servers: [{ name: 'graft', type: 'local', enabled: true, scope: 'global' }], events: [{ t: at, run: 'r1', kind: 'closed', name: 'graft', shutdown: false }], logFrom: at },
  });
  assert.deepEqual([s.totals.toolCalls, s.totals.activeMs, s.totals.compactions, s.totals.prompts, s.totals.sessions], [2, 5 * MIN, 0, 0, 1]);
  assert.deepEqual(s.tools.map(x => x.tool).sort(), ['bash', 'graft_find_code']);
  assert.deepEqual([s.session.id, s.session.title], ['s1', 'Shop']);
  // The list to choose from is never narrowed, and subagent calls count under their parent.
  assert.deepEqual(s.sessions.map(x => [x.id, x.project, x.toolCalls]), [['s2', 'blog', 2], ['s1', 'shop', 2]]);
  // Per server: the subagent's call is in, the other session's failure is out, and the
  // disconnect from the log is not attributed to any one session.
  assert.deepEqual([s.mcp[0].calls, s.mcp[0].faults, s.mcp[0].disconnects], [1, 0, null]);

  const all = run({ tools: [tool('d', 's1', 'graft_find_code', at, at + MIN, { status: 'error', error: 'MCP error -32000: Connection closed' })],
    mcp: { servers: [{ name: 'graft', type: 'local', enabled: true, scope: 'global' }], events: [{ t: at, run: 'r1', kind: 'closed', name: 'graft', shutdown: false }], logFrom: at } });
  assert.deepEqual([all.session, all.mcp[0].calls, all.mcp[0].faults, all.mcp[0].disconnects, all.mcpLogFrom], [null, 1, 1, 1, at]);
});

test('tokens: what was sent and written, the share served from cache, and how big a session starts', () => {
  const at = NOW - 3 * HOUR;
  const reply = (session, offset, input, cacheRead, output, extra = {}) => ({
    session_id: session, role: 'assistant', time_created: at + offset, completed: at + offset + MIN,
    tokens_input: input, tokens_cache_read: cacheRead, tokens_cache_write: 0, tokens_output: output, tokens_reasoning: 0, cost: 0, ...extra,
  });
  const s = run({
    sessions: [
      { id: 's1', parent_id: null, directory: '/work/shop', title: 'Shop', time_created: at - MIN },
      { id: 's1-sub', parent_id: 's1', directory: '/work/shop', title: 'Explore', time_created: at },
      { id: 'old', parent_id: null, directory: '/work/blog', title: 'Blog', time_created: NOW - 30 * 24 * HOUR },
    ],
    messages: [
      reply('s1', 0, 32_000, 0, 200),
      reply('s1', 2 * MIN, 4_000, 32_000, 150, { cost: 0.25 }),
      reply('s1-sub', 3 * MIN, 9_000, 0, 50), // a subagent starts smaller: not a session start
      reply('old', 4 * MIN, 500, 90_000, 100), // began before the range: its first request is not in view
      { session_id: 's1', role: 'user', time_created: at, completed: null },
      reply('s1', 5 * MIN, 0, 0, 0), // still being written: nothing reported yet
    ],
  });
  assert.deepEqual(
    [s.usage.requests, s.usage.input, s.usage.cacheRead, s.usage.output, s.usage.cost, s.usage.cachedPct],
    [4, 45_500, 122_000, 500, 0.25, 73],
  );
  assert.deepEqual(s.usage.start, { median: 32_000, min: 32_000, max: 32_000, sessions: 1 });
  assert.equal(s.daily.find(d => d.date === dayKey(at)).tokens, 45_500 + 122_000 + 500);
  assert.equal(run({}).usage.start, null);
});
