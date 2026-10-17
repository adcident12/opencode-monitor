// The Now tab for an assistant, read off the snapshot the page shows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nowView } from '../src/now-view.mjs';

const NOW = Date.parse('2026-10-17T09:00:00Z');
const session = (id, state, extra = {}) => ({
  id, parentId: null, title: `Session ${id}`, project: 'shop', model: 'local/qwen', state, reason: 'tool', detail: null, since: NOW - 60_000,
  current: null, prompt: null, progress: { todos: null }, health: { contextPct: 40, compaction: { room: 30_000, requestsLeft: 6 }, compactions: 1, compacting: false, hints: [], loop: null },
  ...extra,
});

test('most urgent first, with how long, what it waits on, and its context', () => {
  const snap = {
    now: NOW, stale: false, opencodeRunning: true, opencodeVersion: '2.0.29',
    sessions: [
      session('a', 'working', { since: NOW - 5000, current: { tool: 'bash', summary: 'npm test', startedAt: NOW - 4000 } }),
      session('b', 'waiting', { reason: 'permission', prompt: { kind: 'permission', permission: 'bash', detail: 'git push' } }),
      session('c', 'stuck'),
    ],
    environment: { checkedAt: NOW, models: [{ name: 'local', ok: false, error: 'timeout', settings: { model: 'qwen' } }], mcp: [{ name: 'graft', status: 'ok', kind: null }, { name: 'github', status: 'disabled', kind: null }], services: [] },
  };
  const v = nowView(snap);
  assert.deepEqual(v.sessions.map(s => s.id), ['b', 'c', 'a']);
  assert.equal(v.needYou, 1);
  assert.deepEqual(v.sessions[0].prompt, { kind: 'permission', permission: 'bash', detail: 'git push' });
  assert.deepEqual(v.sessions[2].current, { tool: 'bash', summary: 'npm test', forMs: 4000 });
  assert.deepEqual(v.sessions[2].context, { pct: 40, roomTokens: 30_000, requestsLeft: 6, compactions: 1, compacting: false });
  assert.equal(v.sessions[1].forMs, 60_000);
  assert.deepEqual(v.environment.models, [{ name: 'local', ok: false, error: 'timeout', loaded: 'qwen', mismatches: [] }]);
  assert.deepEqual(v.environment.mcp.map(m => m.name), ['graft']);
  assert.equal(v.at, '2026-10-17T09:00:00.000Z');
});

test('a subagent waiting is counted once, on its parent; one session with those under it', () => {
  const snap = {
    now: NOW,
    sessions: [
      session('p', 'waiting', { reason: 'child_waiting' }),
      session('k', 'waiting', { parentId: 'p' }),
      session('x', 'working'),
    ],
    environment: null,
  };
  assert.equal(nowView(snap).needYou, 1);
  assert.deepEqual(nowView(snap, { session: 'p' }).sessions.map(s => s.id), ['p', 'k']);
  assert.equal(nowView(snap).environment, null);
});
