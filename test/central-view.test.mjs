// OpenCode Central: what the hub's page and API show has no content in it — the parts that need text are removed,
// and any filler or hash that still reaches an answer (a field nobody listed) becomes null.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripContent } from '../src/central/view.mjs';

const F = '·'.repeat(12);
const H = `#${'a'.repeat(16)}${'·'.repeat(5)}`;
const session = {
  id: 's1', title: 'cart', project: 'shop', state: 'waiting', reason: 'permission',
  current: { tool: 'bash', summary: F, startedAt: 1, output: { lines: [F] } },
  progress: { lastActivityAt: 2, steps: [{ tool: 'read', text: H, status: 'completed', startedAt: 1, durationMs: 5 }] },
  work: { files: { count: 2, recent: ['f:0123456789abcdef'] }, git: { branch: 'main' }, running: [{ cmd: F }] },
  review: { counts: { risky: 1 }, total: 1, items: [{ text: F }], ignored: 0, more: 0 },
  prompt: { kind: 'permission', permission: 'bash', detail: F },
  health: { contextTokens: 31000, contextPct: 24 },
};

test('state: the content parts of a session are gone, the figures stay', () => {
  const out = stripContent('state', { now: 1, sessions: [session] }).sessions[0];
  assert.equal(out.current.summary, null);
  assert.equal(out.current.output, null);
  assert.equal(out.current.tool, 'bash');
  assert.equal(out.progress.steps[0].text, null);
  assert.equal(out.progress.steps[0].durationMs, 5);
  assert.deepEqual(out.work.files.recent, []);
  assert.equal(out.work.files.count, 2);
  assert.equal(out.work.running, null);
  assert.equal(out.work.git.branch, 'main');
  assert.deepEqual([out.review.items, out.review.total, out.review.counts], [[], 0, {}]);
  assert.equal(out.prompt.detail, null);
  assert.equal(out.prompt.permission, 'bash');
  assert.deepEqual(out.health, session.health);
});

test('anything else: filler and hashes become null wherever they are', () => {
  const out = stripContent('stats', { slow: [{ tool: 'bash', text: F, ms: 9 }], rereads: [{ file: 'f:0123456789abcdef', count: 3 }], nested: { deep: [H, 'ok'] } });
  assert.deepEqual(out.slow[0], { tool: 'bash', text: null, ms: 9 });
  assert.deepEqual(out.rereads[0], { file: null, count: 3 });
  assert.deepEqual(out.nested.deep, [null, 'ok']);
  assert.doesNotMatch(JSON.stringify(stripContent('tasks', { projects: [{ name: 'shop', sessions: [{ plan: { items: [{ text: F }] } }] }] })), /·{3,}/);
});

test('ordinary text with a dot or a hash sign is left alone', () => {
  assert.deepEqual(stripContent('stats', { a: 'v2.0.29', b: '#1 fix', c: 'a·b' }), { a: 'v2.0.29', b: '#1 fix', c: 'a·b' });
});
