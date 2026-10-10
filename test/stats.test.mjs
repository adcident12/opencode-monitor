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

test('model speed: tokens per second while writing, and while reading a new prompt', () => {
  const at = NOW - 3 * HOUR;
  const reply = (id, model, offset, input, output, extra = {}) => ({
    id, session_id: 's1', role: 'assistant', provider_id: 'local', model_id: model, time_created: at + offset, completed: at + offset + 10 * MIN,
    tokens_input: input, tokens_cache_read: 0, tokens_cache_write: 0, tokens_output: output, tokens_reasoning: 0, cost: 0, ...extra,
  });
  const s = run({
    messages: [
      reply('m1', 'qwen', 0, 30_000, 300),
      reply('m2', 'qwen', HOUR, 100, 900),
      reply('m3', 'qwen', 2 * HOUR, 40, 5), // five tokens say nothing about speed
      reply('m4', 'bonsai', 2 * HOUR, 2_000, 100),
      reply('m5', 'qwen', 2 * HOUR, 50, 800), // no timing recorded for it: left out
    ],
    steps: new Map([
      // First token after 60 s, then 10 s of writing. The tool it called ran for minutes after.
      ['m1', { first_token: at + 60_000, written: at + 70_000 }],
      ['m2', { first_token: at + HOUR + 1000, written: at + HOUR + 31_000 }],
      ['m3', { first_token: at + 2 * HOUR + 1000, written: at + 2 * HOUR + 1200 }],
      ['m4', { first_token: at + 2 * HOUR + 4000, written: at + 2 * HOUR + 9000 }],
    ]),
  });
  const [qwen, bonsai] = s.speed.models;
  // 1200 tokens over 40 s of writing; 30 000 prompt tokens read in 60 s; the short prompts do not count.
  assert.deepEqual([qwen.model, qwen.requests, qwen.writeTps, qwen.readTps, qwen.firstTokenMs], ['local/qwen', 3, 30, 500, 1000]);
  assert.deepEqual([bonsai.model, bonsai.writeTps, bonsai.readTps], ['local/bonsai', 20, 500]);
  assert.equal(qwen.daily.length, 7);
  assert.equal(qwen.daily[s.daily.findIndex(d => d.date === dayKey(at))], 30);
  assert.equal(qwen.daily.filter(v => v != null).length, 1);
  assert.deepEqual(run({}).speed.models, []);
});

test('before and after a day: rates and typical values, so halves of different length compare', async () => {
  const { summarize } = await import('../src/stats.mjs');
  const DAY_MS = 24 * HOUR;
  const session = (id, daysAgo) => ({ id, parent_id: null, directory: '/work/shop', title: id, time_created: NOW - daysAgo * DAY_MS });
  const first = (id, daysAgo, tokens) => ({
    id: `m-${id}`, session_id: id, role: 'assistant', provider_id: 'local', model_id: 'qwen', time_created: NOW - daysAgo * DAY_MS + MIN, completed: NOW - daysAgo * DAY_MS + 2 * MIN,
    tokens_input: tokens, tokens_cache_read: 0, tokens_cache_write: 0, tokens_output: 100, tokens_reasoning: 0, cost: 0,
  });
  const input = {
    sessions: [session('a', 5), session('b', 4), session('c', 1)],
    messages: [first('a', 5, 40_000), first('b', 4, 44_000), first('c', 1, 30_000)],
    compactions: [{ session_id: 'a', time_created: NOW - 5 * DAY_MS + HOUR }, { session_id: 'a', time_created: NOW - 5 * DAY_MS + 2 * HOUR }, { session_id: 'b', time_created: NOW - 4 * DAY_MS + HOUR }],
    tools: [
      tool('t1', 'a', 'read', NOW - 5 * DAY_MS + HOUR, NOW - 5 * DAY_MS + HOUR + 1000, { file: '/x' }),
      tool('t2', 'a', 'read', NOW - 5 * DAY_MS + HOUR + 2000, NOW - 5 * DAY_MS + HOUR + 3000, { file: '/x' }),
      tool('t3', 'a', 'read', NOW - 5 * DAY_MS + HOUR + 4000, NOW - 5 * DAY_MS + HOUR + 5000, { file: '/x', status: 'error' }),
      tool('t4', 'c', 'bash', NOW - DAY_MS + HOUR, NOW - DAY_MS + HOUR + 1000),
    ],
  };
  // Split two days ago: sessions a and b fall before it, c after.
  const before = summarize(run({ ...input, now: new Date(dayKey(NOW - 2 * DAY_MS) + 'T00:00:00').getTime() - 1, days: 4 }), 'local/qwen');
  const after = summarize(run({ ...input, days: 3 }), 'local/qwen');
  assert.deepEqual(
    [before.days, before.sessions, before.startTokens, before.compactionsPerSession, before.rereadsPerSession, before.toolErrorPct],
    [4, 2, 42_000, 1.5, 0.5, 33.3],
  );
  assert.deepEqual(
    [after.days, after.sessions, after.startTokens, after.compactionsPerSession, after.rereadsPerSession, after.toolErrorPct],
    [3, 1, 30_000, 0, 0, 0],
  );
  // Nothing to divide by is "unknown", never zero.
  const empty = summarize(run({ sessions: [] }));
  assert.deepEqual([empty.compactionsPerSession, empty.toolErrorPct, empty.writeTps, empty.startTokens], [null, null, null, null]);
});

test('one session: how its context filled, where it was compacted, and what was read again', () => {
  const at = NOW - 5 * HOUR;
  const reply = (offset, sent) => ({
    id: `m${offset}`, session_id: 's1', role: 'assistant', provider_id: 'local', model_id: 'qwen', time_created: at + offset * MIN, completed: at + offset * MIN + 1000,
    tokens_input: 1000, tokens_cache_read: sent - 1000, tokens_cache_write: 0, tokens_output: 50, tokens_reasoning: 0, cost: 0,
  });
  const read = (id, offset, file, extra = {}) => tool(id, 's1', 'read', at + offset * MIN, at + offset * MIN + 500, { file, ...extra });
  const input = {
    // At minute 30.5 the summarising call still sends everything; the next request is the small one.
    messages: [reply(0, 30_000), reply(10, 80_000), reply(20, 120_000), reply(30.5, 121_000), reply(31, 35_000), reply(40, 60_000),
      { ...reply(15, 999_000), session_id: 'other' }],
    compactions: [{ session_id: 's1', time_created: at + 30 * MIN }, { session_id: 'other', time_created: at + 5 * MIN }],
    tools: [
      read('r1', 1, '/a.ts'), read('r2', 2, '/b.ts'), read('r3', 3, '/a.ts'),
      read('r4', 32, '/a.ts'), read('r5', 33, '/a.ts'), read('r6', 34, '/new.ts'),
      read('r7', 35, '/b.ts', { status: 'error' }), // a read that failed read nothing again
    ],
    contextLimit: (provider, model) => (provider === 'local' && model === 'qwen' ? 131_072 : null),
  };
  const { context } = run({ ...input, sessionId: 's1' });
  assert.deepEqual([context.limit, context.peak, context.requests, context.rereadAfterCompaction], [131_072, 121_000, 6, 1]);
  assert.deepEqual(context.points.map(p => p.tokens), [30_000, 80_000, 120_000, 121_000, 35_000, 60_000]);
  // Compacted from 120k down to 35k, and one file it had already read was read again.
  assert.deepEqual(context.compactions, [{ t: at + 30 * MIN, at: 3, before: 120_000, after: 35_000, reread: 1 }]);
  // A context window belongs to a session: without one selected there is nothing to draw.
  assert.equal(run(input).context, null);
});

test('the session list says what each session cost, subagents counted for their parent', () => {
  const at = NOW - 3 * HOUR;
  const s = run({
    sessions: [
      { id: 's1', parent_id: null, directory: '/work/shop', title: 'Shop', time_created: at },
      { id: 's1-sub', parent_id: 's1', directory: '/work/shop', title: 'Explore', time_created: at },
      { id: 's2', parent_id: null, directory: '/work/blog', title: 'Blog', time_created: at },
    ],
    tools: [tool('a', 's1', 'bash', at, at + MIN), tool('b', 's2', 'bash', at, at + MIN, { id: 'b' })],
    messages: [
      { id: 'm1', session_id: 's1', role: 'assistant', time_created: at, completed: at + 10 * MIN, tokens_input: 1000, tokens_cache_read: 9000, tokens_output: 500 },
      { id: 'm2', session_id: 's1-sub', role: 'assistant', time_created: at, completed: at + 5 * MIN, tokens_input: 2000, tokens_cache_read: 0, tokens_output: 100 },
      { id: 'm3', session_id: 's2', role: 'assistant', time_created: at, completed: at + MIN, tokens_input: 10, tokens_cache_read: 0, tokens_output: 10 },
    ],
    compactions: [{ session_id: 's1-sub', time_created: at + MIN }],
    // Even with another session selected, the list keeps every session's own figures.
    sessionId: 's2',
  });
  const shop = s.sessions.find(x => x.id === 's1');
  assert.deepEqual([shop.activeMs, shop.tokens, shop.compactions, shop.waitMs], [15 * MIN, 12_600, 1, 0]);
  assert.deepEqual([s.sessions.find(x => x.id === 's2').activeMs, s.totals.activeMs], [MIN, MIN]);
});
