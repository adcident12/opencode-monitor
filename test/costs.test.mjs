// What the agent cost, by day, month, model and session, and against a budget.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { costReport, costsFrom, createCostSource } from '../src/costs.mjs';
import { createNotifier } from '../src/notify.mjs';
import { loadConfig } from '../src/config.mjs';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Local time, as the report counts days: the 17th of October, at 12:00.
const NOW = new Date(2026, 9, 17, 12, 0).getTime();
const at = (month, day, hour = 10) => new Date(2026, month, day, hour).getTime();
const reply = (t, cost, extra = {}) => ({ session_id: 's1', time_created: t, provider_id: 'cloud', model_id: 'large', cost, tokens_input: 1000, tokens_output: 200, tokens_reasoning: 0, tokens_cache_read: 5000, tokens_cache_write: 0, ...extra });

test('today, this month and where it ends at this pace, each day and each month', () => {
  const rows = [
    reply(at(9, 17, 9), 1.5),
    reply(at(9, 17, 11), 0.5, { model_id: 'small', session_id: 's2' }),
    reply(at(9, 3), 4),
    reply(at(8, 20), 10),
    reply(at(3, 1), 99), // older than six months: not in the report
    reply(at(9, 17, 11), 0), // free: not counted
  ];
  const r = costReport(rows, { now: NOW });
  assert.deepEqual(r.today, { cost: 2, requests: 2, tokens: 12_400 });
  assert.equal(r.month.cost, 6);
  assert.equal(r.month.month, '2026-10');
  // 16.5 of 31 days gone: 6 / (16.5 / 31).
  assert.equal(r.month.projected, Math.round((6 / ((NOW - at(9, 1, 0)) / (at(10, 1, 0) - at(9, 1, 0)))) * 10_000) / 10_000);
  assert.equal(r.daily.length, 31);
  assert.deepEqual(r.daily.at(-1), { date: '2026-10-17', cost: 2, requests: 2, tokens: 12_400 });
  assert.deepEqual(r.monthly.map(m => [m.month, m.cost]), [['2026-05', 0], ['2026-06', 0], ['2026-07', 0], ['2026-08', 0], ['2026-09', 10], ['2026-10', 6]]);
  assert.deepEqual(r.monthly.at(-1).models.map(m => [m.model, m.cost]), [['cloud/large', 5.5], ['cloud/small', 0.5]]);
  assert.deepEqual(r.models.map(m => [m.model, m.requests, m.input, m.cacheRead]), [['cloud/large', 2, 2000, 10_000], ['cloud/small', 1, 1000, 5000]]);
  assert.deepEqual(r.sessions.map(s => [s.session_id, s.cost]), [['s1', 5.5], ['s2', 0.5]]);
  assert.equal(r.any, true);
  assert.deepEqual(r.budget, { warnPct: 80, daily: null, monthly: null, projected: null });
});

test('no projection a day into the month: it would be a guess', () => {
  const now = new Date(2026, 9, 2, 9).getTime();
  assert.equal(costReport([reply(now - 3_600_000, 3)], { now }).month.projected, null);
  assert.equal(costReport([], { now }).any, false);
});

test('the budget: the share used, warn from warnPct, over at the whole, and a month heading past it', () => {
  const rows = [reply(at(9, 17, 9), 8.5), reply(at(9, 5), 40)];
  const r = costReport(rows, { now: NOW, budget: { daily: 10, monthly: 50, warnPct: 80 } });
  assert.deepEqual(r.budget.daily, { limit: 10, spent: 8.5, pct: 85, level: 'warn' });
  assert.deepEqual(r.budget.monthly, { limit: 50, spent: 48.5, pct: 97, level: 'warn' });
  assert.ok(r.budget.projected > 50);
  assert.equal(costReport(rows, { now: NOW, budget: { daily: 8, monthly: 0 } }).budget.daily.level, 'over');
  assert.equal(costReport(rows, { now: NOW, budget: { daily: 100 } }).budget.daily.level, 'ok');
});

test('the source reads from the start of the earliest month shown, once a minute', () => {
  let reads = 0;
  const db = { stats: { costs: since => (reads++, assert.equal(since, costsFrom(NOW)), [reply(at(9, 17, 9), 1)]), sessions: () => [{ id: 's1', directory: '/work/shop', title: 'Checkout' }] } };
  const report = createCostSource({ db, cfg: { budget: { daily: 0, monthly: 0, warnPct: 80 } } });
  assert.deepEqual(report(NOW).sessions.map(s => [s.project, s.title]), [['shop', 'Checkout']]);
  report(NOW + 30_000);
  assert.equal(reads, 1);
  report(NOW + 61_000);
  assert.equal(reads, 2);
  assert.equal(costsFrom(NOW), at(4, 1, 0));
});

test('told once at warnPct and once at the whole, each day; not what was so at startup', () => {
  const sent = [];
  const notify = createNotifier(
    { on: ['budget'], repeatMinutes: 30, desktop: true, discord: { webhookUrl: '', mention: '', includeDetail: false } },
    (key, vars = {}) => `${key}${vars.pct ? ` ${vars.pct}` : ''}`,
    { desktop: (title, body) => sent.push(`${title} | ${body}`), discord: () => {} },
  );
  const budget = (level, pct) => ({ warnPct: 80, daily: { limit: 10, spent: pct / 10, pct, level }, monthly: null });
  notify.budget(budget('over', 120), NOW);
  assert.equal(sent.length, 0, 'already over when the monitor started');
  notify.budget(budget('over', 130), NOW + 60_000);
  assert.equal(sent.length, 0);
  const tomorrow = NOW + 86_400_000;
  notify.budget(budget('ok', 10), tomorrow);
  notify.budget(budget('warn', 85), tomorrow + 1);
  notify.budget(budget('warn', 90), tomorrow + 2);
  notify.budget(budget('over', 101), tomorrow + 3);
  assert.deepEqual(sent, ['notify.budget.daily.warn 85 | notify.budget.daily.body 85', 'notify.budget.daily.over 101 | notify.budget.daily.body 101']);
});

test('a budget is a number of dollars, and warnPct a whole share', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ocm-budget-'));
  try {
    const file = join(dir, 'config.json');
    const load = budget => {
      writeFileSync(file, JSON.stringify({ budget }));
      return loadConfig({ config: file }, {});
    };
    assert.deepEqual(load({ monthly: 50 }).budget, { daily: 0, monthly: 50, warnPct: 80 });
    assert.throws(() => load({ daily: '10' }), /budget\.daily must be a number/);
    assert.throws(() => load({ monthly: -1 }), /budget\.monthly must be a number/);
    assert.throws(() => load({ warnPct: 0 }), /budget\.warnPct/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
