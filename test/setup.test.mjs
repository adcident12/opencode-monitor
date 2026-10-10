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
