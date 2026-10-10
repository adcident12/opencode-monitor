import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReplay } from '../src/replay.mjs';

const T = 1_800_000_000_000;
const s = n => T + n * 1000;
const show = (text, max = 200) => String(text ?? '').replace(/sk-[a-z0-9]+/g, '•••').slice(0, max);

function input(extra = {}) {
  const tree = [
    { id: 'root', parent_id: null, directory: '/work/shop', title: 'Checkout flow', time_created: s(0), time_updated: s(300) },
    { id: 'kid', parent_id: 'root', directory: '/work/shop', title: 'Look for price code (@explore subagent)', time_created: s(100), time_updated: s(160) },
  ];
  const messages = [
    { id: 'u1', session_id: 'root', role: 'user', time_created: s(0) },
    { id: 'a1', session_id: 'root', role: 'assistant', agent: 'build', time_created: s(1), completed: s(90), finish: 'tool-calls', provider_id: 'p', model_id: 'm', tokens_input: 30_000, tokens_cache_read: 2000, tokens_cache_write: 0 },
    { id: 'a2', session_id: 'root', role: 'assistant', agent: 'build', time_created: s(200), completed: s(260), finish: 'stop', provider_id: 'p', model_id: 'm', tokens_input: 40_000, tokens_cache_read: 0, tokens_cache_write: 0 },
    // A compaction: its summary message is not a request of the conversation.
    { id: 'c1', session_id: 'root', role: 'assistant', agent: 'compaction', summary: 1, time_created: s(170), completed: s(190), tokens_input: 90_000 },
    { id: 'k1', session_id: 'kid', role: 'assistant', agent: 'explore', time_created: s(100), completed: s(160), finish: 'stop' },
  ];
  const tools = [
    { id: 't1', session_id: 'root', tool: 'bash', status: 'completed', started: s(10), ended: s(60), time_created: s(10), time_updated: s(60), cmd: 'npm test --token sk-abc123' },
    { id: 't2', session_id: 'kid', tool: 'read', status: 'completed', started: s(110), ended: s(115), time_created: s(110), time_updated: s(115), file: '/work/shop/price.ts' },
  ];
  return {
    tree,
    messages,
    tools,
    spans: [{ session_id: 'root', type: 'reasoning', s: s(3), e: s(9) }, { session_id: 'root', type: 'text', s: s(240), e: s(258) }],
    steps: new Map([['a1', { message_id: 'a1', first_token: s(3) }], ['a2', { message_id: 'a2', first_token: s(205) }]]),
    compactions: [{ session_id: 'root', time_created: s(170) }],
    todoWrites: [
      { session_id: 'root', time_created: s(5), todos: JSON.stringify([{ content: 'Read the cart', status: 'in_progress' }, { content: 'Fix the total', status: 'pending' }]) },
      { session_id: 'root', time_created: s(250), todos: 'not json' },
    ],
    asks: [{ t: s(10) + 100, kind: 'permission', permission: 'bash', patterns: 'npm test' }],
    replies: new Map(),
    eventTimes: new Map([['t1', [s(40)]]]),
    now: s(400),
    stuckMs: 600_000,
    show,
    contextLimit: () => 131_072,
    compactAt: () => 99_072,
    ...extra,
  };
}

test('a row per session, the session first; subagents named by their agent, titled in full', () => {
  const r = buildReplay(input());
  assert.deepEqual(r.rows.map(x => [x.id, x.name, x.sub]), [['root', 'build', false], ['kid', 'explore', true]]);
  assert.equal(r.rows[1].title, 'Look for price code (@explore subagent)');
  assert.deepEqual(r.session, { id: 'root', title: 'Checkout flow', project: 'shop' });
  assert.equal(r.moreSubagents, 0);
});

test('what the agent did, moment by moment, in order and redacted', () => {
  const r = buildReplay(input());
  const kinds = r.rows[0].segs.map(([a, b, kind]) => [(a - T) / 1000, (b - T) / 1000, kind]);
  assert.deepEqual(kinds, [
    [1, 3, 'reading'],
    [3, 9, 'thinking'],
    [10, 60, 'tool'],
    [10.1, 40, 'waiting'],
    [170, 190, 'compact'],
    [200, 205, 'reading'],
    [240, 258, 'writing'],
  ]);
  const tool = r.rows[0].segs.find(x => x[2] === 'tool');
  assert.equal(tool[3], 'bash npm test --token •••');
  assert.equal(r.rows[0].segs.find(x => x[2] === 'waiting')[3], 'bash npm test');
  assert.equal(r.rows[1].segs[0][3], 'read /work/shop/price.ts');
});

test('the turn, the context of each request, the compaction, and the plans that can be read', () => {
  const r = buildReplay(input());
  assert.deepEqual(r.turns, [{ at: s(0), end: s(260), ending: 'done' }]);
  // The summary of the compaction is not a request of the conversation.
  assert.deepEqual(r.context, [[s(1), 32_000], [s(200), 40_000]]);
  assert.deepEqual([r.contextLimit, r.compactAt], [131_072, 99_072]);
  assert.deepEqual(r.compactions, [s(170)]);
  assert.deepEqual(r.plans, [[s(5), [['Read the cart', 'in_progress'], ['Fix the total', 'pending']]]]);
  assert.deepEqual([r.start, r.end], [s(0), s(300)]);
});

test('a prompt from another session at the same moment is not pinned on this one', () => {
  const other = { id: 'x', session_id: 'elsewhere', tool: 'bash', status: 'completed', started: s(10) + 90, ended: s(20), time_created: s(10) + 90, time_updated: s(20) };
  const base = input();
  const r = buildReplay({ ...base, allTools: [...base.tools, other] });
  assert.equal(r.rows[0].segs.filter(x => x[2] === 'waiting').length, 0);
});

test('a call still running lasts until now; no session, no replay', () => {
  const base = input();
  const running = { ...base.tools[0], id: 't3', status: 'running', started: s(380), ended: null, time_updated: s(380) };
  const r = buildReplay({ ...base, tools: [...base.tools, running] });
  assert.deepEqual(r.rows[0].segs.at(-1).slice(0, 3), [s(380), s(400), 'tool']);
  assert.equal(r.end, s(400));
  assert.equal(buildReplay({ ...base, tree: [] }), null);
});
