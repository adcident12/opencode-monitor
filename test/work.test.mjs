import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentsOf, filesOf, permissionsOf, plansOf, timeSplit, turnsOf } from '../src/work.mjs';

const MIN = 60_000;
const NOW = new Date(2026, 9, 8, 12, 0, 0).getTime();
const FROM = NOW - 7 * 24 * 60 * MIN;
const show = text => String(text ?? '');

function context(sessions, scope = null) {
  const sessionById = new Map(sessions.map(s => [s.id, s]));
  const buckets = new Map();
  const bucket = t => {
    if (t < FROM || t > NOW) return null;
    const key = new Date(t).toDateString();
    if (!buckets.has(key)) buckets.set(key, { readingMs: 0, thinkingMs: 0, writingMs: 0, toolMs: 0, files: 0 });
    return buckets.get(key);
  };
  const rootOf = id => {
    let s = sessionById.get(id);
    while (s?.parent_id && sessionById.has(s.parent_id)) s = sessionById.get(s.parent_id);
    return s?.id ?? id;
  };
  return { ctx: { from: FROM, now: NOW, bucket, inScope: id => !scope || scope.has(id), sessionById, rootOf }, buckets };
}
const sessions = [
  { id: 's1', parent_id: null, directory: '/work/shop', title: 'Shop', time_created: NOW - 5 * 60 * MIN, time_updated: NOW - MIN },
  { id: 's1-sub', parent_id: 's1', directory: '/work/shop', title: 'Explore', time_created: NOW - 4 * 60 * MIN, time_updated: NOW - 3 * 60 * MIN },
  { id: 's2', parent_id: null, directory: '/work/blog', title: 'Blog', time_created: NOW - 5 * 60 * MIN, time_updated: NOW - 2 * 60 * MIN },
];
const where = id => ({ project: id.startsWith('s1') ? 'shop' : 'blog', title: id });
const at = minutesAgo => NOW - minutesAgo * MIN;
const user = (session, ago) => ({ id: `u${session}${ago}`, session_id: session, role: 'user', time_created: at(ago) });
const reply = (session, ago, finish, extra = {}) => ({ id: `a${session}${ago}`, session_id: session, role: 'assistant', time_created: at(ago), completed: at(ago) + 30_000, finish, agent: 'build', ...extra });

test('where the time went: reading the prompt, thinking, writing, tools', () => {
  const { ctx } = context(sessions);
  const messages = [reply('s1', 100, 'stop'), reply('s2', 50, 'stop')];
  const steps = new Map([['as1100', { first_token: at(100) + 4000 }], ['as250', { first_token: at(50) + 1000 }]]);
  const total = timeSplit(ctx, {
    spans: [
      { session_id: 's1', type: 'reasoning', s: at(100), e: at(100) + 20_000 },
      { session_id: 's1', type: 'text', s: at(99), e: at(99) + 5000 },
      { session_id: 's2', type: 'text', s: at(50), e: null }, // still being written: not timed
    ],
    calls: [{ at: at(98), runMs: 7000 }, { at: at(97), runMs: null }],
    messages,
    steps,
  });
  assert.deepEqual(total, { readingMs: 5000, thinkingMs: 20_000, writingMs: 5000, toolMs: 7000 });
});

test('a prompt and its replies: how it ended, how many steps, and a compaction is not a new prompt', () => {
  const { ctx } = context(sessions);
  const t = turnsOf(ctx, {
    where, show,
    messages: [
      user('s1', 300), reply('s1', 299, 'tool-calls'), reply('s1', 298, 'tool-calls'), reply('s1', 297, 'stop'),
      user('s1', 200), reply('s1', 199, 'tool-calls'),
      // The compaction writes a user message and a summary: both part of the same turn.
      user('s1', 198), reply('s1', 197, 'stop', { agent: 'compaction', summary: 1 }),
      reply('s1', 196, 'length', { provider_id: 'local', model_id: 'qwen' }),
      user('s1', 150), reply('s1', 149, null, { error_name: 'MessageAbortedError' }),
      user('s2', 100), reply('s2', 99, 'tool-calls'), // no final answer, long ago, and nothing after it
      user('s2', 90), reply('s2', 89, 'tool-calls'), user('s2', 88), reply('s2', 87, 'stop'), // steered: the first went on in the second
      user('s1', 5), reply('s1', 4, 'tool-calls'), // the latest, still going
      { ...user('s1-sub', 140) }, reply('s1-sub', 139, 'stop'), // a subagent's own prompt is not yours
    ],
  });
  assert.equal(t.count, 7);
  assert.deepEqual(t.ended, { done: 2, cut: 1, aborted: 1, error: 0, continued: 2, unanswered: 0, open: 1 });
  assert.deepEqual(t.cut.map(c => [c.model, c.project]), [['local/qwen', 'shop']]);
  // Steps of the finished prompts: 3, 2 (the summary is not one), 1, 1, 1, 1.
  assert.equal(t.medianSteps, 1);
});

test('permission prompts grouped by what they asked for, most frequent first', () => {
  const ask = (permission, patterns, waitMs, answered = true) => ({ kind: 'permission', permission, patterns, t: at(10), waitMs, answeredAt: answered ? at(9) : null });
  const p = permissionsOf([
    ask('external_directory', 'C:\\temp\\*', 6000), ask('external_directory', 'C:\\temp\\*', 4000), ask('bash', 'rm -rf dist', 1000, false),
    { kind: 'question', permission: null, patterns: '', t: at(5), waitMs: 1 },
  ], show);
  assert.equal(p.asked, 3);
  assert.deepEqual(p.top.map(g => [g.permission, g.pattern, g.count, g.waitMs]), [['external_directory', 'C:\\temp\\*', 2, 10_000], ['bash', 'rm -rf dist', 1, 0]]);
});

test('files changed: per project root, counted per edit, subagents under their parent', () => {
  const { ctx, buckets } = context(sessions);
  const patch = (session, ago, files) => ({ session_id: session, time_created: at(ago), files: JSON.stringify(files) });
  const relative = (file, root) => (root && file.startsWith(root) ? file.slice(root.length + 1) : file);
  const f = filesOf(ctx, { where, show, relative, patches: [
    patch('s1', 100, ['/work/shop/a.ts', '/work/shop/b.ts']), patch('s1-sub', 90, ['/work/shop/a.ts']), patch('s2', 80, ['/work/blog/post.md']),
    patch('s2', 70, []), { session_id: 's2', time_created: at(60), files: 'not json' },
  ] });
  assert.deepEqual([f.edits, f.files], [3, 3]);
  assert.deepEqual(f.top[0], { file: 'a.ts', count: 2, project: 'shop', title: 's1' });
  assert.equal([...buckets.values()].reduce((n, b) => n + b.files, 0), 4);
});

test('agents: time, tokens and cost each, and which ran as a subagent', () => {
  const { ctx } = context(sessions);
  const a = agentsOf(ctx, [
    reply('s1', 100, 'stop', { tokens_input: 1000, tokens_output: 100, cost: 0.01 }),
    reply('s1-sub', 90, 'stop', { agent: 'general', tokens_input: 500, tokens_output: 50 }),
    reply('s1-sub', 80, 'stop', { agent: 'general' }),
    // Ran once in a child session, but mostly in top-level ones: not a subagent.
    reply('s1-sub', 70, 'stop', { agent: 'compaction' }), reply('s1', 60, 'stop', { agent: 'compaction' }),
  ]);
  assert.deepEqual(a.map(x => [x.agent, x.requests, x.activeMs, x.tokens, x.cost, x.subagent]), [['general', 2, 60_000, 550, 0, true], ['compaction', 2, 60_000, 0, 0, false], ['build', 1, 30_000, 1100, 0.01, false]]);
});

test('plans: what the agent set out to do, and which sessions left items undone', () => {
  const { ctx } = context(sessions);
  const p = plansOf(ctx, { where, todos: [
    { session_id: 's1', status: 'completed' }, { session_id: 's1', status: 'completed' }, { session_id: 's1-sub', status: 'pending' },
    { session_id: 's2', status: 'in_progress' }, { session_id: 's2', status: 'pending' }, { session_id: 's2', status: 'cancelled' },
    { session_id: 'gone', status: 'pending' },
  ] });
  assert.deepEqual([p.sessions, p.total, p.completed, p.inProgress, p.pending, p.cancelled], [2, 6, 2, 1, 2, 1]);
  assert.deepEqual(p.unfinished.map(u => [u.id, u.pending + u.inProgress]), [['s2', 2], ['s1', 1]]);
});

test('one session: only its own work is counted', () => {
  const { ctx } = context(sessions, new Set(['s2']));
  assert.equal(agentsOf(ctx, [reply('s1', 100, 'stop'), reply('s2', 90, 'stop')]).reduce((n, a) => n + a.requests, 0), 1);
  assert.equal(plansOf(ctx, { where, todos: [{ session_id: 's1', status: 'pending' }] }).total, 0);
});
