import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConfigWatch, diffSettings, flattenSettings } from '../src/config-changes.mjs';

const DAY = 86_400_000;

test('settings are kept by path; secrets are never read, and other text only as a hash', () => {
  const flat = flattenSettings({
    model: 'local-llama/qwen3.8-27b-v3',
    compaction: { auto: true, reserved: 20000 },
    provider: {
      'local-llama': {
        options: { baseURL: 'http://127.0.0.1:8080/v1', apiKey: 'sk-live-123', headers: { 'X-Token': 'abc' } },
        models: { qwen: { limit: { context: 131072, output: 8192 }, options: { reasoningEffort: 'high' } } },
      },
    },
    permission: { bash: { 'npm test': 'allow', '*': 'ask' } },
    mcp: { trivy: { type: 'local', command: ['trivy', 'mcp'], enabled: false, environment: { TOKEN: 'x' } } },
  });
  assert.equal(flat.get('model'), 'local-llama/qwen3.8-27b-v3');
  assert.equal(flat.get('compaction.reserved'), 20000);
  assert.equal(flat.get('provider.local-llama.models.qwen.limit.output'), 8192);
  assert.equal(flat.get('provider.local-llama.models.qwen.options.reasoningEffort'), 'high');
  assert.equal(flat.get('permission.bash.npm test'), 'allow');
  assert.equal(flat.get('mcp.trivy.enabled'), false);
  assert.equal(flat.get('mcp.trivy.type'), 'local');
  // An address and a command: kept only as a hash.
  assert.match(flat.get('provider.local-llama.options.baseURL'), /^#[0-9a-f]{16}$/);
  assert.match(flat.get('mcp.trivy.command'), /^#[0-9a-f]{16}$/);
  // Secrets: not there at all, not even hashed.
  const keys = [...flat.keys()].join(' ');
  assert.doesNotMatch(keys, /apiKey|headers|X-Token|environment|TOKEN/);
  assert.doesNotMatch(JSON.stringify([...flat.values()]), /sk-live|abc/);
});

test('a model name is shown, an address or path given as a model is not', () => {
  assert.equal(flattenSettings({ model: 'a/b-1.5:q4' }).get('model'), 'a/b-1.5:q4');
  assert.match(flattenSettings({ model: 'http://x/y' }).get('model'), /^#/);
  assert.match(flattenSettings({ model: 'C:\\models\\x.gguf' }).get('model'), /^#/);
  assert.match(flattenSettings({ small_model: 'user@host/x' }).get('small_model'), /^#/);
});

test('differences by path: numbers with their values, hashed ones only as changed', () => {
  const a = new Map([['limit.output', 8192], ['url', '#aaaa'], ['gone', true]]);
  const b = new Map([['limit.output', 16384], ['url', '#bbbb'], ['new', 'allow']]);
  assert.deepEqual(diffSettings(a, b), {
    changes: [
      { path: 'gone', kind: 'removed', from: true, to: null },
      { path: 'limit.output', kind: 'changed', from: 8192, to: 16384 },
      { path: 'new', kind: 'added', from: null, to: 'allow' },
      { path: 'url', kind: 'changed', hidden: true },
    ],
    more: 0,
  });
  assert.deepEqual(diffSettings(a, new Map(a)), { changes: [], more: 0 });
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'ocm-cfg-'));
  const config = join(dir, 'opencode.json');
  const write = (obj, mtime) => {
    writeFileSync(config, JSON.stringify(obj));
    utimesSync(config, mtime / 1000, mtime / 1000);
  };
  const make = (now, extra = {}) => createConfigWatch({ files: () => [config], file: join(dir, 'changes.jsonl'), seenFile: join(dir, 'seen.json'), retentionDays: 30, now, ...extra });
  return { dir, config, write, make };
}

test('the first look is the starting point; a later save is a change, dated by the file', () => {
  const { write, make } = setup();
  const t0 = Date.UTC(2026, 9, 1);
  write({ compaction: { reserved: 20000 } }, t0);
  const watch = make(t0);
  assert.deepEqual(watch.check(t0 + 1000), []);
  write({ compaction: { reserved: 10000 } }, t0 + 5000);
  // Not looked at again within the minute.
  assert.deepEqual(watch.check(t0 + 10_000), []);
  const [entry] = watch.check(t0 + 70_000);
  assert.equal(entry.t, t0 + 5000);
  assert.deepEqual(entry.changes, [{ path: 'compaction.reserved', kind: 'changed', from: 20000, to: 10000 }]);
  assert.equal(watch.list().length, 1);
});

test('a change made while the monitor was off is found at the next start', () => {
  const { write, make } = setup();
  const t0 = Date.UTC(2026, 9, 1);
  write({ model: 'a/x' }, t0);
  make(t0).check(t0, true);
  // Stopped; the file is saved two days later; started again on the third.
  write({ model: 'a/y' }, t0 + 2 * DAY);
  const later = make(t0 + 3 * DAY);
  const [entry] = later.check(t0 + 3 * DAY, true);
  assert.equal(entry.t, t0 + 2 * DAY);
  assert.deepEqual(entry.changes, [{ path: 'model', kind: 'changed', from: 'a/x', to: 'a/y' }]);
  // And what was recorded survives the next start.
  assert.equal(make(t0 + 3 * DAY).list()[0].t, t0 + 2 * DAY);
});

test('saving the file without changing a setting records nothing', () => {
  const { write, make } = setup();
  const t0 = Date.UTC(2026, 9, 1);
  write({ model: 'a/x' }, t0);
  const watch = make(t0);
  watch.check(t0, true);
  write({ model: 'a/x' }, t0 + 1000);
  assert.deepEqual(watch.check(t0 + 2000, true), []);
});

test('a half-saved file is skipped and read again next time', () => {
  const { config, write, make } = setup();
  const t0 = Date.UTC(2026, 9, 1);
  write({ model: 'a/x' }, t0);
  const watch = make(t0);
  watch.check(t0, true);
  writeFileSync(config, '{"model": "a/');
  assert.deepEqual(watch.check(t0 + 1000, true), []);
  write({ model: 'a/z' }, t0 + 2000);
  assert.equal(watch.check(t0 + 3000, true)[0].changes[0].to, 'a/z');
});

test('changes past retention are dropped, from the file too', () => {
  const { dir, make } = setup();
  const t0 = Date.UTC(2026, 9, 1);
  const file = join(dir, 'changes.jsonl');
  writeFileSync(file, [{ t: t0 - 40 * DAY, file: 'x', changes: [] }, { t: t0 - DAY, file: 'x', changes: [] }].map(e => JSON.stringify(e)).join('\n') + '\n{broken');
  assert.equal(make(t0).list().length, 1);
  assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 1);
});

test('JSON with comments, as OpenCode allows', () => {
  const { config, make } = setup();
  const t0 = Date.UTC(2026, 9, 1);
  writeFileSync(config, '{\n  // the model\n  "model": "a/x",\n}');
  const watch = make(t0);
  watch.check(t0, true);
  writeFileSync(config, '{\n  "model": "a/y", /* new */\n}');
  assert.equal(watch.check(t0 + 1000, true)[0].changes[0].to, 'a/y');
});
