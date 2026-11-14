// OpenCode Central: batches wait on disk until the hub has them. The hub being away for a day, the agent
// restarting, or the queue filling up never loses a batch silently and never stops the agent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOutbox } from '../src/central/outbox.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'ocm-outbox-'));
const env = seq => ({ v: 1, seq, ct: 'x'.repeat(100) });

test('sends in order, removes a batch only once the hub said ok', async () => {
  const dir = tmp();
  try {
    const got = [];
    let fail = 3;
    let now = 0;
    const ob = createOutbox({ dir, now: () => now, send: async e => { if (fail-- > 0) throw new Error('down'); got.push(e.seq); return { ok: true, seq: e.seq }; } });
    for (let i = 0; i < 3; i++) ob.put(env);
    for (let i = 0; i < 6; i++) { await ob.flush(); now += 11 * 60_000; }
    assert.deepEqual(got, [1, 2, 3]);
    assert.equal(readdirSync(dir).filter(f => /^\d{10}-\d+\.json$/.test(f)).length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('backoff: 5 s doubling to at most 10 minutes; nothing is sent before it is due', async () => {
  const dir = tmp();
  try {
    let now = 0;
    let calls = 0;
    const ob = createOutbox({ dir, now: () => now, send: async () => { calls++; throw new Error('down'); } });
    ob.put(env);
    const waits = [];
    for (let i = 0; i < 9; i++) { await ob.flush(); waits.push(ob.nextTryAt() - now); now = ob.nextTryAt(); }
    assert.deepEqual(waits, [5000, 10000, 20000, 40000, 80000, 160000, 320000, 600000, 600000]);
    const before = calls;
    await ob.flush(); // due now
    await ob.flush(); // not due again yet
    assert.equal(calls, before + 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a restart loses nothing and keeps counting seq', async () => {
  const dir = tmp();
  try {
    const a = createOutbox({ dir, send: async () => { throw new Error('down'); } });
    a.put(env);
    a.put(env);
    const sent = [];
    const b = createOutbox({ dir, send: async e => { sent.push(e.seq); return { ok: true, seq: e.seq }; } });
    assert.equal(b.put(env), 3);
    await b.flush();
    assert.deepEqual(sent, [1, 2, 3]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('over the size or age cap the oldest go first and are counted', async () => {
  const dir = tmp();
  try {
    let now = 1_000_000;
    const ob = createOutbox({ dir, now: () => now, maxBytes: 600, maxAgeMs: 60_000, send: async () => { throw new Error('down'); } });
    for (let i = 0; i < 10; i++) ob.put(env);
    let r = await ob.flush();
    assert.ok(r.dropped >= 5, `dropped ${r.dropped}`);
    assert.ok(r.kept * 150 <= 600 + 150);
    now += 120_000;
    r = await ob.flush();
    assert.equal(r.kept, 0, 'all past the age cap');
    assert.ok(ob.droppedTotal() >= 10);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a hub answer that is not ok keeps the batch', async () => {
  const dir = tmp();
  try {
    const ob = createOutbox({ dir, send: async () => ({ ok: false }) });
    ob.put(env);
    const r = await ob.flush();
    assert.deepEqual([r.sent, r.kept], [0, 1]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a batch the hub refuses for good (400, 413) is set aside, and the queue moves on', async () => {
  const dir = tmp();
  try {
    const sent = [];
    const ob = createOutbox({ dir, send: async e => { if (e.seq === 1) return { ok: false, status: 413 }; sent.push(e.seq); return { ok: true, seq: e.seq }; } });
    ob.put(env); ob.put(env);
    const r = await ob.flush();
    assert.deepEqual(sent, [2]);
    assert.equal(r.rejected, 1);
    assert.equal(readdirSync(join(dir, 'rejected')).length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a 401 (token being replaced) is not "for good": the batch waits', async () => {
  const dir = tmp();
  try {
    const ob = createOutbox({ dir, send: async () => ({ ok: false, status: 401 }) });
    ob.put(env);
    const r = await ob.flush();
    assert.deepEqual([r.sent, r.kept, r.rejected], [0, 1, 0]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('every batch carries the queue\'s instance id; a lost or unreadable seq file starts a new instance', () => {
  const dir = tmp();
  try {
    const a = createOutbox({ dir, send: async () => ({ ok: true }) });
    const id1 = a.instance();
    assert.match(id1, /^[0-9a-f]{16}$/);
    assert.equal(createOutbox({ dir, send: async () => ({ ok: true }) }).instance(), id1, 'same queue, same instance');
    writeFileSync(join(dir, 'seq'), 'garbage');
    const c = createOutbox({ dir, send: async () => ({ ok: true }) });
    assert.notEqual(c.instance(), id1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
