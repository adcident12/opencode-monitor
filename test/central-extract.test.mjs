// OpenCode Central: the agent reads only what changed in opencode.db since last time, scrubbed, and never
// disturbs OpenCode: a database it cannot read right now is a cycle skipped, not an error.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createExtractor } from '../src/central/extract.mjs';

const ctx = { hmacKey: Buffer.alloc(32, 1), machine: 'poppy' };
const opened = [];
const ex = o => { const x = createExtractor(o); opened.push(x); return x; };
const closeAll = () => { for (const x of opened.splice(0)) x.close(); };

function makeDb({ v1 = true, v2 = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ocm-extract-'));
  const path = join(dir, 'opencode.db');
  const db = new DatabaseSync(path);
  if (v1) db.exec(`
    create table session (id text primary key, parent_id text, directory text, title text, time_created int, time_updated int, version text);
    create table message (id text primary key, session_id text, time_created int, time_updated int, data text);
    create table part (id text primary key, message_id text, session_id text, time_created int, time_updated int, data text);
    create table todo (session_id text, content text, status text, priority text, position int);`);
  if (v2) db.exec(`
    create table session_v2 (id text primary key, parent_id text, directory text, title text, time_created int, time_updated int);
    create table session_message (id text primary key, session_id text, type text, seq int, time_created int, time_updated int, data text);`);
  return { dir, path, db };
}

const T = 1_800_000_000_000;
function seed(db) {
  db.prepare('insert into session values (?,?,?,?,?,?,?)').run('s1', null, 'C:\\work\\shop', 'cart', T, T + 10, '1.18');
  db.prepare('insert into message values (?,?,?,?,?)').run('m1', 's1', T, T + 10, JSON.stringify({ role: 'assistant', tokens: { input: 5 } }));
  db.prepare('insert into part values (?,?,?,?,?,?)').run('p1', 'm1', 's1', T, T + 10, JSON.stringify({ type: 'text', text: 'SECRET' }));
  db.prepare('insert into todo values (?,?,?,?,?)').run('s1', 'SECRET todo', 'pending', 'high', 0);
}

test('first read: every row of every table, scrubbed', () => {
  const { dir, path, db } = makeDb({ v2: false });
  try {
    seed(db);
    const r = ex({ dbPath: path, ...ctx }).next({});
    assert.deepEqual(Object.keys(r.rows).sort(), ['message', 'part', 'session', 'todo']);
    assert.equal(r.rows.session[0].directory, '/poppy/shop');
    assert.doesNotMatch(JSON.stringify(r.rows), /SECRET/);
    assert.equal(r.more, false);
  } finally { closeAll(); db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('next read: only what changed, plus what falls inside the overlap', () => {
  const { dir, path, db } = makeDb({ v2: false });
  try {
    seed(db);
    const x = ex({ dbPath: path, ...ctx, overlapMs: 0 });
    const first = x.next({});
    db.prepare('insert into part values (?,?,?,?,?,?)').run('p2', 'm1', 's1', T + 50_000, T + 50_000, JSON.stringify({ type: 'step-start' }));
    db.prepare('update message set time_updated = ?, data = ? where id = ?').run(T + 60_000, JSON.stringify({ role: 'assistant', tokens: { input: 9 } }), 'm1');
    const second = x.next(first.cursor);
    assert.deepEqual(second.rows.part.map(p => p.id), ['p2']);
    assert.deepEqual(second.rows.message.map(m => m.id), ['m1']);
    assert.equal(second.rows.session, undefined, 'unchanged table: nothing');
    assert.equal(second.rows.todo, undefined, 'todo unchanged: not sent again');
    // With an overlap, rows written up to that long before the last one seen are read again (a write that
    // committed late with an older time is not missed); the hub dedupes them.
    const y = ex({ dbPath: path, ...ctx, overlapMs: 20_000 });
    const again = y.next(second.cursor);
    assert.deepEqual(again.rows.part.map(p => p.id), ['p2']);
    // The same reader does not return them again while unchanged: no traffic every cycle for the last minutes.
    assert.equal(y.next(again.cursor).rows.part, undefined);
  } finally { closeAll(); db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a batch is capped; the rest comes next time without skipping or repeating forever', () => {
  const { dir, path, db } = makeDb({ v2: false });
  try {
    seed(db);
    const ins = db.prepare('insert into part values (?,?,?,?,?,?)');
    for (let i = 0; i < 300; i++) ins.run(`p${String(i).padStart(3, '0')}x`, 'm1', 's1', T, T + 10, JSON.stringify({ type: 'text', text: 'a'.repeat(1000) }));
    const x = ex({ dbPath: path, ...ctx, maxBytes: 50_000 });
    const seen = new Set();
    let cursor = {};
    for (let i = 0; i < 50; i++) {
      const r = x.next(cursor);
      for (const p of r.rows.part ?? []) seen.add(p.id);
      cursor = r.cursor;
      if (!r.more) break;
    }
    assert.equal(seen.size, 301);
  } finally { closeAll(); db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a 1.x-only or 2-only database: the missing tables are skipped', () => {
  const { dir, path, db } = makeDb({ v1: false });
  try {
    db.prepare('insert into session_v2 values (?,?,?,?,?,?)').run('s2', null, '/a/web', 'w', T, T);
    const r = ex({ dbPath: path, ...ctx }).next({});
    assert.deepEqual(Object.keys(r.rows), ['session_v2']);
  } finally { closeAll(); db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a database locked by a writer: null, no throw, and it works on the next cycle', () => {
  const { dir, path, db } = makeDb({ v2: false });
  try {
    seed(db);
    db.exec('begin exclusive; update session set title = title;');
    const x = ex({ dbPath: path, ...ctx });
    assert.equal(x.next({}), null);
    db.exec('commit');
    assert.equal(x.next({}).rows.session.length, 1);
  } finally { closeAll(); db.close(); rmSync(dir, { recursive: true, force: true }); }
});
