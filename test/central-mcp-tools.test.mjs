// OpenCode Central, /mcp: the monitor's own tools over every machine the hub has. A `machine` argument picks one;
// without it, one machine answers as itself and several answer side by side, never mixed. What only a machine's own
// disk knows (its config files, MCP servers, model servers, config saves) is not claimed here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCentralTools } from '../src/central/mcp-tools.mjs';
import { createCentralStore } from '../src/central/store.mjs';

const NOW = Date.parse('2026-11-14T12:00:00Z');
const H = 3_600_000;

function fakeContext(name, { version = '1.18.35', versions = [] } = {}) {
  const asked = [];
  const stats = (days = 14) => ({ range: { from: NOW - days * 86_400_000, to: NOW, days }, sessions: [{ id: `s-${name}`, title: `${name} work`, lastAt: NOW - H }], takeaways: [], speed: { models: [{ model: 'llama/qwen', output: { max: 900, replies: 10, p99: 800 } }] }, filler: '·····' });
  stats.compareAt = (at, hours) => { asked.push({ at, hours }); return { before: { hours }, after: { hours }, reliable: true }; };
  return {
    asked,
    stats,
    tasks: () => ({ range: { from: NOW - 7 * 86_400_000, to: NOW, days: 7 }, total: 0, open: 0, projects: [] }),
    overnight: null,
    costs: () => ({ any: false }),
    snapshot: () => ({ now: NOW, sessions: [] }),
    facts: { opencodeVersion: version, opencode: { limits: [['llama/qwen', 131072]], reserves: [], compaction: { buffer: 2000 }, outputTokenMax: null, model: 'llama/qwen' } },
    versions: () => versions,
  };
}

function toolsWith(contexts, llamaEvents = () => []) {
  const tools = buildCentralTools({ machines: () => Object.keys(contexts), contextOf: n => contexts[n], llamaEvents, redact: s => s, now: () => NOW });
  return Object.fromEntries(tools.map(t => [t.name, t]));
}

test('every tool takes `machine`; config saves are not offered, the version timeline is', () => {
  const tools = toolsWith({ alpha: fakeContext('alpha') });
  assert.ok(!tools.opencode_config_changes);
  assert.ok(tools.opencode_versions);
  for (const t of Object.values(tools)) assert.equal(t.inputSchema.properties.machine.type, 'string', t.name);
});

test('one machine answers as itself; several answer side by side; an unknown one is an error', () => {
  const one = toolsWith({ alpha: fakeContext('alpha') });
  const r1 = one.opencode_sessions.run({ days: 7 });
  assert.equal(r1.machine, 'alpha');
  assert.equal(r1.sessions[0].id, 's-alpha');

  const two = toolsWith({ alpha: fakeContext('alpha'), beta: fakeContext('beta') });
  const both = two.opencode_sessions.run({ days: 7 });
  assert.deepEqual(Object.keys(both.machines), ['alpha', 'beta']);
  assert.equal(both.machines.beta.sessions[0].id, 's-beta');
  assert.equal(two.opencode_sessions.run({ days: 7, machine: 'beta' }).sessions[0].id, 's-beta');
  assert.match(two.opencode_sessions.run({ machine: 'gamma' }).error, /gamma/);
});

test('answers pass the content net: filler left anywhere becomes null', () => {
  const tools = toolsWith({ alpha: fakeContext('alpha') });
  assert.equal(tools.opencode_stats.run({}).filler, null);
});

test('settings: model limits from the facts, nothing that only the machine knows', () => {
  const s = toolsWith({ alpha: fakeContext('alpha') }).opencode_settings.run({});
  assert.equal(s.models[0].model, 'llama/qwen');
  assert.equal(s.models[0].context, 131072);
  assert.equal(s.compaction.buffer, 2000);
  for (const k of ['configFiles', 'configFilesNote', 'mcpServers', 'modelServers', 'modelServersNote']) assert.ok(!(k in s), k);
});

test('versions: each OpenCode version seen, with its first and last session, and the current one', () => {
  const versions = [{ version: '1.18.30', firstAt: NOW - 50 * H, lastAt: NOW - 30 * H, sessions: 4 }, { version: '1.18.35', firstAt: NOW - 20 * H, lastAt: NOW - H, sessions: 2 }];
  const v = toolsWith({ alpha: fakeContext('alpha', { versions }) }).opencode_versions.run({});
  assert.equal(v.current, '1.18.35');
  assert.deepEqual(v.versions.map(x => [x.version, x.firstAt]), [['1.18.30', new Date(NOW - 50 * H).toISOString()], ['1.18.35', new Date(NOW - 20 * H).toISOString()]]);
});

test('compare without `at`: the newest change, an OpenCode version or a llama.cpp event', () => {
  const versions = [{ version: '1.18.30', firstAt: NOW - 50 * H, lastAt: NOW - 30 * H, sessions: 4 }, { version: '1.18.35', firstAt: NOW - 20 * H, lastAt: NOW - H, sessions: 2 }];
  const ctx = fakeContext('alpha', { versions });
  const tools = toolsWith({ alpha: ctx }, () => [{ t: NOW - 5 * H, kind: 'restart', profile: 'qwen' }, { t: NOW - 90 * H, kind: 'seen', profile: 'qwen' }]);
  const r = tools.opencode_compare.run({ hours: 6 });
  assert.equal(ctx.asked[0].at, NOW - 5 * H);
  assert.equal(r.event.kind, 'llama:restart');

  const ctx2 = fakeContext('alpha', { versions });
  toolsWith({ alpha: ctx2 }).opencode_compare.run({});
  assert.equal(ctx2.asked[0].at, NOW - 20 * H, 'the first session of the newest version');

  assert.match(toolsWith({ alpha: fakeContext('alpha') }).opencode_compare.run({}).error, /at/);
});

test('the store lists the versions of the top-level sessions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ocm-ver-'));
  const store = createCentralStore({ dir });
  const s = (id, v, t, parent = null) => ({ id, parent_id: parent, directory: '/a/x', title: 't', time_created: t, time_updated: t, version: v });
  store.apply({ machine: 'alpha', seq: 1, rows: { session: [s('a', '1.0.0', NOW - 9 * H), s('b', '1.0.0', NOW - 8 * H), s('c', '1.1.0', NOW - 2 * H), s('d', '2.0.0', NOW, 'c')] }, facts: null });
  try {
    assert.deepEqual(store.versions('alpha'), [{ version: '1.0.0', firstAt: NOW - 9 * H, lastAt: NOW - 8 * H, sessions: 2 }, { version: '1.1.0', firstAt: NOW - 2 * H, lastAt: NOW - 2 * H, sessions: 1 }]);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
