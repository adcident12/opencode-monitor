import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDigest, digestDue, digestLines } from '../src/digest.mjs';
import { createNotifier } from '../src/notify.mjs';
import { loadTranslator } from '../src/format.mjs';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// Monday 5 October 2026, 09:00 local time.
const MONDAY_9 = new Date(2026, 9, 5, 9, 0, 0).getTime();

test('due at the chosen weekday and hour, once, and not a day late', () => {
  const due = (now, lastSent = 0) => digestDue({ now, weekday: 1, hour: 9, lastSent });
  assert.equal(due(MONDAY_9 - 1), null, 'not before the hour (last week\'s is too old)');
  assert.equal(due(MONDAY_9), MONDAY_9);
  assert.equal(due(MONDAY_9 + 5 * HOUR), MONDAY_9, 'the monitor was started later that day');
  assert.equal(due(MONDAY_9 + 5 * HOUR, MONDAY_9), null, 'already sent');
  assert.equal(due(MONDAY_9 + DAY), null, 'started on Tuesday: Monday\'s is not sent late');
  assert.equal(due(MONDAY_9 + 7 * DAY, MONDAY_9), MONDAY_9 + 7 * DAY, 'the next week');
  // Sunday is 0.
  assert.equal(digestDue({ now: MONDAY_9, weekday: 0, hour: 20 }), MONDAY_9 - 13 * HOUR);
});

const stats = () => ({
  totals: { sessions: 12, activeMs: 5 * HOUR, waitMs: 20 * 60_000 },
  takeaways: [
    { id: 'permission_repeat', tone: 'act', vars: { n: 7, permission: 'external_directory', pattern: 'C:\\Users\\me\\secret-project\\*' }, anchor: 'stats-you' },
    { id: 'cache_low', tone: 'act', vars: { pct: 30, requests: 400 }, anchor: 'stats-model' },
  ],
});

test('the summary: one line of totals, then a sentence per takeaway; paths only if details are allowed', () => {
  const t = loadTranslator('en');
  const lines = digestLines(stats(), t);
  assert.equal(lines[0], '12 sessions in the last 7 days · the agent worked 5h 0m · waited 20m for you');
  assert.equal(lines[1], '• You were asked 7 times to allow the same external_directory. A permission rule in opencode.json would stop asking.');
  assert.match(lines[2], /^• Only 30% of what was sent over 400 requests/);
  assert.doesNotMatch(lines.join('\n'), /secret-project/);
  assert.match(digestLines(stats(), t, { includeDetail: true })[1], /secret-project/);
  assert.deepEqual(digestLines({ ...stats(), takeaways: [] }, t).slice(1), ['Nothing stood out this week.']);
  // Every language has the strings.
  assert.doesNotMatch(digestLines(stats(), loadTranslator('th')).join('\n'), /digest\.|takeaways\./);
});

function setup(notify = {}) {
  const cfg = { on: [], desktop: true, repeatMinutes: 0, discord: { webhookUrl: 'https://discord.com/api/webhooks/1/x', mention: '', includeDetail: false }, weekly: { enabled: true, weekday: 1, hour: 9 }, ...notify };
  const sent = { desktop: [], discord: [] };
  const t = loadTranslator('en');
  const notifier = createNotifier(cfg, t, { desktop: (...a) => sent.desktop.push(a), discord: async (hook, text) => (sent.discord.push(text), null) }, { quiet: true });
  const stateFile = join(mkdtempSync(join(tmpdir(), 'ocm-digest-')), 'data', 'weekly.json');
  const make = () => createDigest({ cfg, stats, send: notifier.send, t, stateFile });
  return { cfg, sent, notifier, make, stateFile };
}

test('sent once when due, to Discord only, and remembered across a restart', () => {
  const { sent, notifier, make, stateFile } = setup();
  const digest = make();
  assert.equal(digest.check(MONDAY_9 - HOUR), false);
  assert.equal(digest.check(MONDAY_9 + 60_000), true);
  assert.equal(sent.discord.length, 1);
  assert.match(sent.discord[0], /^\*\*Your week with OpenCode\*\*\n12 sessions/);
  assert.equal(sent.desktop.length, 0, 'a pop-up cannot hold it');
  assert.deepEqual([notifier.recent()[0].kind, notifier.recent()[0].desktop], ['weekly', 'off']);
  assert.equal(digest.check(MONDAY_9 + 3 * 60_000), false);
  assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).lastSent, MONDAY_9);
  // The monitor is restarted the same morning.
  assert.equal(make().check(MONDAY_9 + 2 * HOUR), false);
  assert.equal(sent.discord.length, 1);
});

test('off by default, and nothing without a webhook', () => {
  const off = setup({ weekly: { enabled: false, weekday: 1, hour: 9 } });
  assert.equal(off.make().check(MONDAY_9), false);
  const noHook = setup({ discord: { webhookUrl: '', mention: '', includeDetail: false } });
  assert.equal(noHook.make().check(MONDAY_9), false);
  assert.equal(off.sent.discord.length + noHook.sent.discord.length, 0);
});

test('a summary that cannot be built is not retried every minute', () => {
  const { cfg, notifier, sent } = setup();
  let calls = 0;
  const digest = createDigest({ cfg, stats: () => { calls++; throw new Error('database is locked'); }, send: notifier.send, t: loadTranslator('en') });
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(digest.check(MONDAY_9), true);
    assert.equal(digest.check(MONDAY_9 + 2 * 60_000), false);
  } finally {
    console.warn = warn;
  }
  assert.equal(calls, 1);
  assert.equal(sent.discord.length, 0);
});
