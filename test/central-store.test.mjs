// OpenCode Central, hub side: one OpenCode-shaped database per machine, so the monitor's own reader opens it
// unchanged. Batches apply idempotently, an older copy of a row never overwrites a newer one, 180 days are kept.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCentralStore } from '../src/central/store.mjs';
import { openDb } from '../src/db.mjs';

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const sess = (id, t, title = 'cart') => ({ id, parent_id: null, directory: '/poppy/shop', title, time_created: t, time_updated: t, version: '2.0.29' });
const msg = (id, sid, t, input = 5) => ({ id, session_id: sid, time_created: t, time_updated: t, data: JSON.stringify({ role: 'assistant', tokens: { input } }) });
const batch = (seq, rows, facts = null) => ({ machine: 'poppy', seq, sentAt: NOW, rows, facts });

function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ocm-store-'));
  const store = createCentralStore({ dir });
  try { return fn(store, dir); } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
}

test('applied rows are read by the unchanged openDb()', () => withStore(store => {
  assert.deepEqual(store.apply(batch(1, { session: [sess('s1', NOW)], message: [msg('m1', 's1', NOW)] })), { seq: 1, applied: true });
  const db = openDb(store.dataDirOf('poppy'));
  try {
    assert.ok(db, 'layout check passed');
  } finally { db.close?.(); }
}));

test('the same seq again: acknowledged, not applied', () => withStore(store => {
  store.apply(batch(1, { session: [sess('s1', NOW)] }));
  assert.deepEqual(store.apply(batch(1, { session: [sess('s1', NOW, 'changed')] })), { seq: 1, applied: false });
  assert.equal(store.row('poppy', 'session', 's1').title, 'cart');
}));

test('an older copy of a row never overwrites a newer one', () => withStore(store => {
  store.apply(batch(1, { message: [msg('m1', 's1', NOW + 100, 9)] }));
  store.apply(batch(2, { message: [msg('m1', 's1', NOW, 5)] }));
  assert.equal(JSON.parse(store.row('poppy', 'message', 'm1').data).tokens.input, 9);
  store.apply(batch(3, { message: [msg('m1', 's1', NOW + 200, 12)] }));
  assert.equal(JSON.parse(store.row('poppy', 'message', 'm1').data).tokens.input, 12);
}));

test('facts are kept as the latest, with when they arrived; machines are listed', () => withStore(store => {
  store.apply(batch(1, {}, { at: NOW, running: true, opencodeVersion: '2.0.29' }));
  store.apply(batch(2, { session: [sess('s1', NOW)] }));
  const [m] = store.machines();
  assert.deepEqual([m.name, m.lastSeq, m.facts.opencodeVersion], ['poppy', 2, '2.0.29']);
  assert.equal(typeof m.lastAt, 'number');
}));

test('todo rows replace the machine\'s whole todo list', () => withStore(store => {
  store.apply(batch(1, { todo: [{ session_id: 's1', content: '··', status: 'pending', position: 0 }, { session_id: 's2', content: '·', status: 'done', position: 0 }] }));
  store.apply(batch(2, { todo: [{ session_id: 's1', content: '··', status: 'completed', position: 0 }] }));
  assert.deepEqual(store.all('poppy', 'todo').map(t => [t.session_id, t.status]), [['s1', 'completed']]);
}));

test('prune: rows past 180 days and their orphans go', () => withStore(store => {
  store.apply(batch(1, { session: [sess('old', NOW - 200 * DAY), sess('new', NOW)], message: [msg('m_old', 'old', NOW - 200 * DAY), msg('m_new', 'new', NOW)],
    part: [{ id: 'p_old', message_id: 'm_old', session_id: 'old', time_created: NOW - 200 * DAY, time_updated: NOW - 200 * DAY, data: '{}' }] }));
  store.prune(NOW);
  assert.deepEqual(store.all('poppy', 'session').map(s => s.id), ['new']);
  assert.deepEqual(store.all('poppy', 'message').map(s => s.id), ['m_new']);
  assert.deepEqual(store.all('poppy', 'part'), []);
}));

test('a machine name that is not a plain word is refused', () => withStore(store => {
  for (const name of ['../x', 'Poppy', '', 'a b', 'x'.repeat(33)]) assert.throws(() => store.apply({ ...batch(1, {}), machine: name }), /machine/);
}));

test('columns outside the layout are ignored, not written', () => withStore(store => {
  store.apply(batch(1, { session: [{ ...sess('s1', NOW), share_url: 'x' }] }));
  assert.equal('share_url' in store.row('poppy', 'session', 's1'), false);
}));

test('prune also reaches machines this process has not opened yet (a restarted hub)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ocm-store-'));
  try {
    const a = createCentralStore({ dir });
    a.apply(batch(1, { session: [sess('old', NOW - 200 * DAY)] }));
    a.close();
    const b = createCentralStore({ dir });
    b.prune(NOW);
    assert.deepEqual(b.all('poppy', 'session'), []);
    b.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a new agent instance (reinstalled machine) starts its seq again and is applied', () => withStore(store => {
  store.apply({ ...batch(5, { session: [sess('s1', NOW)] }), instance: 'aaaaaaaaaaaaaaaa' });
  assert.deepEqual(store.apply({ ...batch(1, { session: [sess('s2', NOW)] }), instance: 'bbbbbbbbbbbbbbbb' }), { seq: 1, applied: true });
  assert.deepEqual(store.apply({ ...batch(1, { session: [sess('s3', NOW)] }), instance: 'bbbbbbbbbbbbbbbb' }), { seq: 1, applied: false });
}));
