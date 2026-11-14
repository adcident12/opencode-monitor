// OpenCode Central: the hub's second check must pass everything the agent's scrub produces from a real-shaped
// database (or the machine's data would be lost), and refuse text that got past it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSample } from '../scripts/make-sample.mjs';
import { createExtractor } from '../src/central/extract.mjs';
import { contentFree } from '../src/central/guard.mjs';

test('every batch the scrub makes from the sample database passes the guard', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ocm-guard-'));
  const x = createExtractor({ dbPath: join(buildSample(join(dir, 'sample')), 'opencode.db'), hmacKey: Buffer.alloc(32, 3), machine: 'poppy', maxBytes: 200_000 });
  try {
    let cursor = {};
    let batches = 0;
    for (let i = 0; i < 100; i++) {
      const r = x.next(cursor);
      batches++;
      assert.equal(contentFree({ rows: r.rows, facts: { running: true, opencodeVersion: '2.0.29' } }), true, `batch ${batches}`);
      x.acknowledge(r);
      cursor = r.cursor;
      if (!r.more) break;
    }
    assert.ok(batches >= 1);
  } finally { x.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('text with a line break, long text, or text in todo content or in facts is refused', () => {
  const part = data => ({ rows: { part: [{ id: 'p', data: JSON.stringify(data) }] } });
  assert.equal(contentFree(part({ type: 'text', text: 'a\nb' })), false);
  assert.equal(contentFree(part({ type: 'text', text: 'x'.repeat(201) })), false);
  assert.equal(contentFree({ rows: { todo: [{ session_id: 's', content: 'write tests', status: 'pending' }] } }), false);
  assert.equal(contentFree({ rows: {}, facts: { log: { asks: [{ id: 'per_1', patterns: 'rm -rf /\nsecret' }] } } }), false);
  assert.equal(contentFree(part({ type: 'tool', tool: 'bash', state: { input: { '#': `#0123456789abcdef${'·'.repeat(500)}` }, output: '·'.repeat(5000) } })), true);
});
