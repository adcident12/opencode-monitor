import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHistory } from '../src/history.mjs';

const DAY = 86_400_000;
const T = 1_800_000_000_000;
const s = (id, state, extra = {}) => ({ id, parentId: null, state, reason: 'tool', since: T, title: `T-${id}`, project: 'shop', current: { summary: 'npm test' }, ...extra });

test('records only changes of state, with how long the previous state lasted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ocm-h-'));
  const file = join(dir, 'nested', 'history.jsonl');
  try {
    const history = createHistory({ file, retentionDays: 30, now: T });
    history.record([s('a', 'working')], T);
    history.record([s('a', 'working')], T + 2000);
    history.record([s('a', 'waiting', { reason: 'permission', prompt: { permission: 'bash', detail: 'rm -rf build' } }), s('c', 'waiting', { parentId: 'a' })], T + 60_000);
    history.record([s('a', 'working')], T + 600_000);

    const [third, second, first] = history.list();
    assert.equal(history.count, 3, 'the subagent is covered by its parent');
    assert.deepEqual([first.from, first.to, first.detail], [null, 'working', 'npm test']);
    assert.deepEqual([second.from, second.fromMs, second.to, second.permission, second.detail], ['working', 60_000, 'waiting', 'bash', 'rm -rf build']);
    assert.deepEqual([third.from, third.fromMs, third.to], ['waiting', 540_000, 'working']);
    assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 3);

    // A restart picks up where it left off instead of logging everything again.
    appendFileSync(file, '{"broken');
    const again = createHistory({ file, retentionDays: 30, now: T + DAY });
    again.record([s('a', 'working')], T + DAY);
    assert.equal(again.count, 3);
    again.record([s('a', 'finished')], T + DAY + 1000);
    assert.equal(again.list()[0].from, 'working');

    // Past retention, old entries are dropped from memory and from the file.
    const later = createHistory({ file, retentionDays: 30, now: T + 30 * DAY + 700_000 });
    assert.deepEqual(later.list().map(e => e.to), ['finished']);
    assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('works in memory without a file, and can be switched off', () => {
  const memory = createHistory({ file: null, retentionDays: 30 });
  memory.record([s('a', 'stuck')], T);
  assert.equal(memory.count, 1);
  const off = createHistory({ file: null, retentionDays: 30, enabled: false });
  off.record([s('a', 'stuck')], T);
  assert.equal(off.count, 0);
});

test('one session can be picked out, from the whole record and not only the newest entries', () => {
  const history = createHistory({ file: null, retentionDays: 30, now: T });
  history.record([s('a', 'working'), s('b', 'working')], T);
  for (let i = 1; i <= 400; i++) history.record([s('a', 'working'), s('b', i % 2 ? 'waiting' : 'working')], T + i * 1000);
  history.record([s('a', 'finished'), s('b', 'working')], T + 500_000);

  assert.deepEqual(history.list({ session: 'a' }).map(e => e.to), ['finished', 'working']);
  assert.equal(history.list().length, 300);
  assert.deepEqual(history.sessions().map(x => [x.id, x.title, x.count]), [['a', 'T-a', 2], ['b', 'T-b', 401]]);
});
