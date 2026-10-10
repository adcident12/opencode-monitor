import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSetupReport, formatSetupReport } from '../src/setup.mjs';
import { DEFAULTS } from '../src/config.mjs';

const NOW = 1_800_000_000_000;

function machine({ withData = true } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'ocm-setup-'));
  const configDir = mkdtempSync(join(tmpdir(), 'ocm-setup-cfg-'));
  if (withData) {
    writeFileSync(join(dataDir, 'opencode.db'), 'x');
    mkdirSync(join(dataDir, 'log'));
    writeFileSync(join(dataDir, 'log', 'opencode.log'), '');
    writeFileSync(join(configDir, 'opencode.jsonc'), '{}');
  }
  const cfg = structuredClone(DEFAULTS);
  Object.assign(cfg, { dataDir, opencodeConfigDir: configDir, configFile: { path: join(configDir, 'config.json'), found: false } });
  return cfg;
}
const opencode = (extra = {}) => ({
  limits: new Map([['llama/big', 131_072], ['llama/small', 32_768]]),
  reserves: new Map([['llama/big', { output: 32_768, input: null }], ['llama/small', { output: 4096, input: null }]]),
  compaction: {}, mcp: [{ name: 'graft', type: 'local', enabled: true }], providers: [], ...extra,
});
const db = models => ({ stats: { models: () => models } });
const used = (provider, model, requests = 10) => ({ provider, model, requests, last: NOW - 1000 });

test('each model in use gets its own compaction point, from that machine\'s own limits', () => {
  const report = buildSetupReport({ cfg: machine(), opencode: opencode(), db: db([used('llama', 'big'), used('llama', 'small'), used('other', 'mystery')]), opencodeVersion: '1.18.35', now: NOW });
  const byId = Object.fromEntries(report.models.map(m => [m.id, m]));
  assert.deepEqual([byId['llama/big'].context, byId['llama/big'].compactAt, byId['llama/big'].source], [131_072, 99_072, 'opencode']);
  assert.deepEqual([byId['llama/small'].context, byId['llama/small'].compactAt], [32_768, 28_672]);
  // No limit anywhere: said, not guessed.
  assert.deepEqual([byId['other/mystery'].context, byId['other/mystery'].compactAt, byId['other/mystery'].source], [null, null, null]);
  assert.deepEqual(report.problems, [{ code: 'model_limit_unknown', subject: 'other/mystery' }]);
});

test('a limit given in the monitor\'s own config is used and marked as such; compaction off is reported', () => {
  const cfg = machine();
  cfg.contextLimit.models = { 'other/mystery': 64_000 };
  const report = buildSetupReport({ cfg, opencode: opencode({ compaction: { auto: false } }), db: db([used('other', 'mystery')]), opencodeVersion: '1.19.0', now: NOW });
  assert.deepEqual([report.models[0].context, report.models[0].source, report.models[0].compactAt], [64_000, 'monitor', null]);
  assert.deepEqual(report.problems.map(p => p.code), ['untested_opencode', 'compaction_off']);
  assert.equal(report.compaction.auto, false);
});

test('a machine with nothing on it: every missing piece is named, and no secret is in the report', () => {
  const cfg = machine({ withData: false });
  cfg.notify.desktop = false;
  cfg.notify.discord.webhookUrl = 'https://discord.com/api/webhooks/123/secret-token';
  const report = buildSetupReport({ cfg, opencode: opencode({ limits: new Map(), reserves: new Map(), mcp: [] }), db: null, now: NOW });
  assert.deepEqual(report.problems.map(p => p.code), ['no_database', 'no_log', 'no_opencode_config']);
  assert.deepEqual([report.notify.discord, report.models, report.notify.recent], [true, [], []]);
  assert.ok(!JSON.stringify(report).includes('secret-token'));

  const text = formatSetupReport(report, (key, vars = {}) => `${key}${vars.subject ? ' ' + vars.subject : ''}`);
  assert.match(text, /setup\.problem\.no_database /);
  assert.ok(!text.includes('secret-token'));
});

test('the weekly summary: when it goes out, or why it does not', async () => {
  const { weeklyText } = await import('../src/setup.mjs');
  const { loadTranslator } = await import('../src/format.mjs');
  const t = loadTranslator('en');
  assert.equal(weeklyText({ discord: true, weekly: { enabled: false, weekday: 1, hour: 9 } }, t), 'off');
  assert.equal(weeklyText({ discord: false, weekly: { enabled: true, weekday: 1, hour: 9 } }, t), 'On, but no Discord webhook is set, so nothing is sent');
  assert.equal(weeklyText({ discord: true, weekly: { enabled: true, weekday: 1, hour: 9 } }, t), 'Monday at 09:00, to Discord');
  assert.equal(weeklyText({ discord: true, weekly: { enabled: true, weekday: 0, hour: 20 } }, t), 'Sunday at 20:00, to Discord');
});

test('--doctor lists each model with its window and where it is compacted, or says the limit is unknown', async () => {
  const { loadTranslator } = await import('../src/format.mjs');
  const cfg = machine();
  cfg.contextLimit.models = { 'other/mystery': 64_000 };
  const report = buildSetupReport({ cfg, opencode: opencode(), db: db([used('llama', 'small'), used('other', 'mystery'), used('other', 'nolimit')]), opencodeVersion: '1.18.35', now: NOW });
  assert.deepEqual(Object.fromEntries(report.models.map(m => [m.id, m.source])), { 'llama/small': 'opencode', 'other/mystery': 'monitor', 'other/nolimit': null });
  const text = formatSetupReport(report, loadTranslator('en'));
  assert.ok(text.includes('llama/small: Context 32.8k, Compacts at 28.7k'), text);
  // No output limit is set for it, so OpenCode keeps its largest reply free: 64,000 - 32,000.
  assert.ok(text.includes('other/mystery: Context 64k, Compacts at 32k'), text);
  assert.ok(text.includes('other/nolimit: limit unknown'), text);
});
