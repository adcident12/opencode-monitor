// Long prompt reads, seen in a llama.cpp server's slots while a session waits on it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReadLog, createReadTracker, longReadsOf } from '../src/reads.mjs';
import { parseSlots } from '../src/model-server.mjs';
import { takeawaysOf } from '../src/takeaways.mjs';

const T = new Date(2026, 9, 17, 9, 48, 29).getTime();
const slot = (task, processed, written, busy = true) => parseSlots([{ id: 0, is_processing: busy, id_task: task, n_prompt_tokens: processed + 2048, n_prompt_tokens_processed: processed, n_prompt_tokens_cache: 0, next_token: [{ n_decoded: written }] }]);

test('a prompt read from the start is said once it is read: how many tokens, for how long it was seen reading', () => {
  // As watched on a real server: 45,836 tokens read from 09:48:29 to 09:49:16, then writing.
  const track = createReadTracker();
  assert.deepEqual(track('local-llama', slot(125186, 87424, 6633), T - 3000), []);
  assert.deepEqual(track('local-llama', slot(128032, 0, 0), T), []);
  assert.deepEqual(track('local-llama', slot(128032, 24759, 0), T + 21_000), []);
  assert.deepEqual(track('local-llama', slot(128032, 45836, 1), T + 47_000), [{ provider: 'local-llama', t: T, tokens: 45836, ms: 47_000 }]);
  // Said once, not again while it writes.
  assert.deepEqual(track('local-llama', slot(128032, 45836, 200), T + 56_000), []);
});

test('a request first seen writing, or a short read, is not said', () => {
  const track = createReadTracker();
  // The one before was writing when first seen: when its reading began is not known.
  assert.deepEqual(track('local-llama', slot(1, 87424, 10), T), []);
  assert.deepEqual(track('local-llama', slot(2, 0, 0), T + 3000), []);
  assert.deepEqual(track('local-llama', slot(2, 600, 1), T + 4000), []);
});

test('kept beside the history, read back by period and session, summed for Stats', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ocm-reads-'));
  const file = join(dir, 'reads.jsonl');
  try {
    const log = createReadLog({ file, retentionDays: 30, now: T });
    log.record({ provider: 'p', t: T, tokens: 45836, ms: 47_000, session: 's1' });
    log.record({ provider: 'p', t: T + 60_000, tokens: 90000, ms: 70_000, session: null });
    assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 2);
    const again = createReadLog({ file, retentionDays: 30, now: T });
    assert.equal(again.between(T - 1, T + 120_000).length, 2);
    assert.equal(again.between(T - 1, T + 120_000, id => id === 'other').length, 1);
    assert.deepEqual(longReadsOf(again.between(T - 1, T + 120_000)), { count: 2, tokens: 135836, ms: 117_000, longest: { provider: 'p', t: T + 60_000, tokens: 90000, ms: 70_000, session: null } });
    // Read only: nothing written.
    createReadLog({ file, retentionDays: 30, readOnly: true }).record({ provider: 'p', t: T, tokens: 9000, ms: 1000 });
    assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ten minutes of long reads or more, three at least, is a takeaway', () => {
  const base = { totals: { sessions: 1 }, usage: {}, tools: [], mcp: [], work: { time: { readingMs: 0, thinkingMs: 0, writingMs: 0, toolMs: 0 }, turns: { ended: { cut: 0 }, cut: [] }, permissions: { asked: 0, top: [] }, plans: { total: 0, dropped: 0 } } };
  const reads = (count, ms) => ({ ...base, longReads: { count, tokens: count * 60000, ms, longest: null } });
  assert.ok(!takeawaysOf(reads(20, 9 * 60_000)).some(t => t.id === 'long_reads'));
  assert.ok(!takeawaysOf(reads(2, 30 * 60_000)).some(t => t.id === 'long_reads'));
  assert.deepEqual(takeawaysOf(reads(20, 25 * 60_000)).find(t => t.id === 'long_reads').vars, { n: 20, minutes: 25, tokens: 1200 });
});
