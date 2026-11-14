// OpenCode Central: the MCP doors of the hub (/mcp, /mcp-llama) open only with a read key. A machine's ingest token,
// the page's access key and the login proxy's secret header each open their own door and not these.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { startHub } from '../src/central/hub.mjs';
import { createCentralStore } from '../src/central/store.mjs';
import { initHubKeys, issueToken, issueReadKey, readReadKeys } from '../src/central/tokens.mjs';
import { DEFAULTS } from '../src/config.mjs';

const SECRET = 'p'.repeat(40);
const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } };

async function withHub(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ocm-rk-'));
  const central = join(dir, 'central');
  const store = createCentralStore({ dir: join(central, 'machines') });
  store.apply({ machine: 'alpha', seq: 1, rows: {}, facts: null });
  store.close();
  initHubKeys(central);
  const token = issueToken(central, 'alpha');
  const readKey = issueReadKey(central, 'claude');
  const cfg = structuredClone(DEFAULTS);
  Object.assign(cfg, { port: 0, pollMs: 200, dataDir: dir, opencodeConfigDir: dir });
  cfg.central = { ...cfg.central, dir: central, proxy: { header: 'x-ocm-proxy', secret: SECRET } };
  cfg.history = { ...cfg.history, file: join(dir, 'data', 'history.jsonl') };
  cfg.notify = { ...cfg.notify, desktop: false };
  const hub = await startHub(cfg);
  const base = `http://127.0.0.1:${hub.port}`;
  const post = (path, headers = {}, body = INIT) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  try { await fn({ post, token, readKey, central }); } finally { await hub.close(); rmSync(dir, { recursive: true, force: true }); }
}

test('a read key is shown once and kept only as its hash', () => withHub(async ({ readKey, central }) => {
  assert.ok(readKey.length >= 40);
  const kept = readReadKeys(central);
  assert.deepEqual(Object.keys(kept), ['claude']);
  assert.notEqual(kept.claude, readKey);
  assert.ok(!readFileSync(join(central, 'read-keys.json'), 'utf8').includes(readKey));
}));

test('/mcp and /mcp-llama answer with the read key', () => withHub(async ({ post, readKey }) => {
  for (const path of ['/mcp', '/mcp-llama']) {
    const res = await post(path, { authorization: `Bearer ${readKey}` });
    assert.equal(res.status, 200, path);
    const body = await res.json();
    assert.ok(body.result.serverInfo.name, path);
  }
}));

test('no key, an ingest token, the proxy header or a wrong key: 401 on both', () => withHub(async ({ post, token, readKey }) => {
  const tries = [{}, { authorization: `Bearer ${token}` }, { 'x-ocm-proxy': SECRET }, { authorization: `Bearer ${readKey}x` }];
  for (const path of ['/mcp', '/mcp-llama']) {
    for (const h of tries) assert.equal((await post(path, h)).status, 401, `${path} ${Object.keys(h)}`);
  }
}));

// (The page and the API keep their own gate, the access key; on loopback, as here, that gate lets everything in.)
test('a read key is not a machine token: /ingest refuses it', () => withHub(async ({ post, readKey }) => {
  assert.equal((await post('/ingest', { authorization: `Bearer ${readKey}` }, { machine: 'alpha' })).status, 401);
}));

test('a name the hub does not answer to: 403, even with the read key', () => withHub(async ({ post, readKey }) => {
  const port = new URL((await post('/mcp', { authorization: `Bearer ${readKey}` })).url).port;
  const status = await new Promise((done, fail) => {
    const r = request({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: { host: 'evil.example', authorization: `Bearer ${readKey}`, 'content-type': 'application/json' } }, res => { res.resume(); done(res.statusCode); });
    r.on('error', fail);
    r.end(JSON.stringify(INIT));
  });
  assert.equal(status, 403);
}));

test('--central-read-key <name> is an option', async () => {
  const { parseArgs } = await import('../src/config.mjs');
  assert.deepEqual(parseArgs(['--central-read-key', 'claude']), { centralReadKey: 'claude' });
});

test('/mcp answers the OpenCode tools for the machines the hub has', () => withHub(async ({ post, readKey }) => {
  const auth = { authorization: `Bearer ${readKey}` };
  const list = await (await post('/mcp', auth, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).json();
  const names = list.result.tools.map(t => t.name);
  assert.ok(names.includes('opencode_versions') && names.includes('opencode_stats') && !names.includes('opencode_config_changes'));
  for (const t of list.result.tools) assert.equal(t.annotations.readOnlyHint, true);
  const call = await (await post('/mcp', auth, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'opencode_versions', arguments: {} } })).json();
  assert.equal(JSON.parse(call.result.content[0].text).machine, 'alpha');
}));
