// OpenCode Central, /mcp-llama: what the llama.cpp server runs, what changed and when, its figures for a period and
// before/after a change, and who used it. Answered from the hub's own cache (llama.mjs); read-only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLlamaTools, statsOf } from '../src/central/mcp-llama.mjs';

const H = 3_600_000;
const NOW = Date.parse('2026-11-14T12:30:00Z');
const hour = (t, o = {}) => ({ t, prompt: 1000, prompt_s: 2, cached: 3000, gen: 100, gen_s: 4, drafts: 50, accepted: 40, queue: 0, busy: 1, ...o });

function fakeSource({ hours = [], events = [], now = { running: true, profile: 'qwen', settings: { ctxSize: 131072 } }, callers = null, configured = true } = {}) {
  return {
    now: () => now,
    events: since => events.filter(e => e.t >= since),
    hourly: (from, to) => hours.filter(r => r.t >= from && r.t < to),
    hoursStatus: () => ({ configured, error: null, until: NOW - 30 * 60_000 }),
    callers: () => callers,
  };
}
const toolsOf = src => Object.fromEntries(buildLlamaTools(src, { now: () => NOW }).map(t => [t.name, t]));

test('the figures of hours, with the same formulas as the dashboard', () => {
  const s = statsOf([hour(0), hour(H, { prompt: 3000, prompt_s: 2, cached: 1000, gen: 300, gen_s: 6, drafts: 50, accepted: 10, queue: 3 }), hour(2 * H, { prompt: 0, prompt_s: 0, cached: 0, gen: 0, gen_s: 0, drafts: 0, accepted: 0 })]);
  assert.equal(s.hours, 3);
  assert.equal(s.workHours, 2);
  assert.equal(s.promptTokens, 4000);
  assert.equal(s.genTokens, 400);
  assert.equal(s.prompt_tps, 1000);           // 4000 / 4 s
  assert.equal(s.gen_tps, 40);                // 400 / 10 s
  assert.equal(s.cached_pct, 50);             // 4000 cached of 8000
  assert.equal(s.draft_pct, 50);              // 50 accepted of 100 drafted
  assert.equal(s.peak_queue, 3);
});

test('no work in the hours: rates are null, not 0 or NaN', () => {
  const s = statsOf([hour(0, { prompt: 0, prompt_s: 0, cached: 0, gen: 0, gen_s: 0, drafts: 0, accepted: 0 })]);
  for (const k of ['prompt_tps', 'gen_tps', 'cached_pct', 'draft_pct']) assert.equal(s[k], null, k);
});

test('llama_stats: the last 24 hours by default, or hours, or between two moments', () => {
  const hours = [hour(NOW - 30 * H), hour(NOW - 5 * H), hour(NOW - 2 * H)];
  const t = toolsOf(fakeSource({ hours }));
  assert.equal(t.llama_stats.run({}).hours, 2);
  assert.equal(t.llama_stats.run({ hours: 48 }).hours, 3);
  assert.equal(t.llama_stats.run({ from: new Date(NOW - 31 * H).toISOString(), to: new Date(NOW - 29 * H).toISOString() }).hours, 1);
});

test('llama_stats without InfluxDB settings: an error that says what is missing', () => {
  assert.match(toolsOf(fakeSource({ configured: false })).llama_stats.run({}).error, /InfluxDB/);
});

test('llama_compare: before and after the newest change by default; unreliable when a side had under an hour of work', () => {
  const at = Math.floor((NOW - 10 * H) / H) * H;
  const hours = [];
  for (let t = at - 6 * H; t < at + 6 * H; t += H) hours.push(hour(t, t >= at ? { gen_s: 2 } : {}));
  const events = [{ t: NOW - 40 * H, kind: 'seen', profile: 'qwen' }, { t: at + 60_000, kind: 'settings', profile: 'qwen', changes: [{ key: 'ctxSize', from: 131072, to: 65536 }] }];
  const r = toolsOf(fakeSource({ hours, events })).llama_compare.run({ hours: 6 });
  assert.equal(r.event.kind, 'settings');
  assert.equal(r.before.gen_tps, 25);
  assert.equal(r.after.gen_tps, 50);
  assert.equal(r.reliable, true);
  const thin = toolsOf(fakeSource({ hours: [hour(at - H)], events })).llama_compare.run({ hours: 6 });
  assert.equal(thin.reliable, false);
});

test('llama_compare with nothing changed yet: asks for `at`', () => {
  assert.match(toolsOf(fakeSource({ events: [{ t: NOW - H, kind: 'seen' }] })).llama_compare.run({}).error, /at/);
});

test('llama_now, llama_changes, llama_callers answer from the cache; none can change anything', () => {
  const events = [{ t: NOW - 50 * 86_400_000, kind: 'restart' }, { t: NOW - 2 * H, kind: 'restart', profile: 'qwen' }];
  const t = toolsOf(fakeSource({ events, callers: { at: NOW, d1: { gen: 1 }, callers: [{ caller: 'ares', requests: 2 }] } }));
  assert.equal(t.llama_now.run({}).profile, 'qwen');
  const ch = t.llama_changes.run({});
  assert.equal(ch.changes.length, 1, '30 days by default');
  assert.equal(ch.changes[0].at, new Date(NOW - 2 * H).toISOString());
  assert.equal(t.llama_callers.run({}).callers[0].caller, 'ares');
  for (const name of Object.keys(t)) assert.match(name, /^llama_(now|changes|stats|compare|callers)$/);
});

test('review: InfluxDB failing or never read is said, not shown as an idle server', () => {
  const failing = { ...fakeSource({ hours: [hour(NOW - 2 * H)] }), hoursStatus: () => ({ configured: true, error: 'InfluxDB answered 401', until: NOW - 3 * H }) };
  const r = toolsOf(failing).llama_stats.run({});
  assert.match(r.warning, /401/);
  assert.equal(r.figuresUntil, new Date(NOW - 3 * H).toISOString());
  const never = { ...fakeSource(), hoursStatus: () => ({ configured: true, error: 'InfluxDB answered 401', until: null }) };
  assert.match(toolsOf(never).llama_stats.run({}).error, /401/);
  assert.match(toolsOf(never).llama_compare.run({ at: new Date(NOW - 5 * H).toISOString() }).error, /401/);
});

test('review: callers with no usage page set says so', () => {
  const t = toolsOf({ ...fakeSource(), callers: () => null, usageConfigured: () => false });
  assert.match(t.llama_callers.run({}).error, /usageUrl/);
});
