// Which model a server had loaded, and replies OpenCode named after another.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServedLog, servedAsOf } from '../src/served.mjs';
import { takeawaysOf } from '../src/takeaways.mjs';

const MIN = 60_000;
const HOUR = 60 * MIN;
const T = new Date(2026, 9, 12, 10, 0).getTime();
const qwen = { model: 'qwen3.8-27b-nvfp4-mtp', file: 'Qwen.gguf', nCtx: 131072 };
const bonsai = { model: 'bonsai2-27b', file: 'Bonsai.gguf', nCtx: 131072 };

test('a line when the model changes, and one an hour while it does not; read back after a restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ocm-served-'));
  const file = join(dir, 'served.jsonl');
  try {
    const log = createServedLog({ file, retentionDays: 30, now: T });
    log.record('local-llama', bonsai, T);
    log.record('local-llama', bonsai, T + 5 * MIN);
    log.record('local-llama', qwen, T + 10 * MIN);
    log.record('local-llama', qwen, T + 10 * MIN + HOUR);
    assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 3);
    const again = createServedLog({ file, retentionDays: 30, now: T + 2 * HOUR });
    assert.equal(again.servedAt('local-llama', T + 9 * MIN).model, 'bonsai2-27b');
    assert.equal(again.servedAt('local-llama', T + 30 * MIN).model, 'qwen3.8-27b-nvfp4-mtp');
    // Before the first line, another provider, or past what was seen: not known.
    assert.equal(again.servedAt('local-llama', T - MIN), null);
    assert.equal(again.servedAt('ollama', T + 30 * MIN), null);
    assert.equal(again.servedAt('local-llama', T + 10 * MIN + 3 * HOUR), null);
    // Read only: nothing written.
    const ro = createServedLog({ file, retentionDays: 30, readOnly: true });
    ro.record('local-llama', bonsai, T + 3 * HOUR);
    assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('replies named after another model than the one loaded, counted by the two names', () => {
  const log = createServedLog({ file: null, retentionDays: 30, now: T });
  log.record('local-llama', qwen, T);
  const reply = (id, model, t, extra = {}) => ({ id, session_id: 's', role: 'assistant', provider_id: 'local-llama', model_id: model, time_created: t, ...extra });
  const messages = [
    ...Array.from({ length: 12 }, (_, i) => reply(`b${i}`, 'bonsai2-27b', T + i * MIN)),
    reply('q', 'qwen3.8-27b-nvfp4-mtp', T + 20 * MIN),
    // A summary, and a reply before anything was seen: not counted.
    reply('c', 'bonsai2-27b', T + 21 * MIN, { agent: 'compaction' }),
    reply('early', 'bonsai2-27b', T - HOUR),
  ];
  const servedAs = servedAsOf(messages, log.servedAt, { from: T - 2 * HOUR, to: T + HOUR });
  assert.deepEqual(servedAs, { checked: 13, differ: [{ asked: 'local-llama/bonsai2-27b', served: 'local-llama/qwen3.8-27b-nvfp4-mtp', replies: 12 }] });
});

test('a server without an alias names no model, so nothing is compared', () => {
  const log = createServedLog({ file: null, retentionDays: 30, now: T });
  log.record('local-llama', { model: null, file: 'Qwen.gguf', nCtx: 131072 }, T);
  const messages = [{ id: 'a', session_id: 's', role: 'assistant', provider_id: 'local-llama', model_id: 'anything', time_created: T + MIN }];
  assert.deepEqual(servedAsOf(messages, log.servedAt, { from: T, to: T + HOUR }), { checked: 0, differ: [] });
});

test('ten replies or more under another name is a takeaway', () => {
  const base = { totals: { sessions: 1 }, usage: {}, tools: [], mcp: [], work: { time: { readingMs: 0, thinkingMs: 0, writingMs: 0, toolMs: 0 }, turns: { ended: { cut: 0 }, cut: [] }, permissions: { asked: 0, top: [] }, plans: { total: 0, dropped: 0 } } };
  const differ = n => ({ ...base, servedAs: { checked: 50, differ: [{ asked: 'local-llama/bonsai2-27b', served: 'local-llama/qwen3.8-27b-nvfp4-mtp', replies: n }] } });
  assert.ok(!takeawaysOf(differ(9)).some(t => t.id === 'served_other'));
  assert.deepEqual(takeawaysOf(differ(12)).find(t => t.id === 'served_other').vars, { n: 12, asked: 'local-llama/bonsai2-27b', served: 'local-llama/qwen3.8-27b-nvfp4-mtp' });
});
