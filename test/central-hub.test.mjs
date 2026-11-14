// OpenCode Central, hub mode (`--central`): one monitor per machine over its OpenCode-shaped database; the page and
// API answer for the machine picked (query or cookie); /ingest takes batches; nothing that needs text is served.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHub } from '../src/central/hub.mjs';
import { createCentralStore } from '../src/central/store.mjs';
import { initHubKeys, issueToken } from '../src/central/tokens.mjs';
import { seal } from '../src/central/seal.mjs';
import { DEFAULTS } from '../src/config.mjs';

const NOW = Date.now();
const sess = (id, title, dir) => ({ id, parent_id: null, directory: dir, title, time_created: NOW - 5000, time_updated: NOW - 4000, version: '1.18.35' });
const msg = (id, sid) => ({ id, session_id: sid, time_created: NOW - 4500, time_updated: NOW - 4000, data: JSON.stringify({ role: 'assistant', modelID: 'qwen', providerID: 'llama', tokens: { input: 50, output: 5 }, time: { created: NOW - 4500, completed: NOW - 4000 }, finish: 'stop' }) });

async function withHub(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ocm-hub-'));
  const central = join(dir, 'central');
  const store = createCentralStore({ dir: join(central, 'machines') });
  store.apply({ machine: 'alpha', seq: 1, rows: { session: [sess('sa', 'alpha work', '/alpha/shop')], message: [msg('ma', 'sa')] }, facts: { running: true, opencodeVersion: '1.18.35', opencode: { limits: [['llama/qwen', 131072]], reserves: [], compaction: {}, outputTokenMax: null, model: 'llama/qwen' } } });
  store.apply({ machine: 'beta', seq: 1, rows: { session: [sess('sb', 'beta work', '/beta/web')], message: [msg('mb', 'sb')] }, facts: null });
  store.close();
  const keys = initHubKeys(central);
  const token = issueToken(central, 'alpha');
  const cfg = structuredClone(DEFAULTS);
  Object.assign(cfg, { port: 0, pollMs: 200, dataDir: dir, opencodeConfigDir: dir });
  cfg.central = { ...cfg.central, dir: central };
  cfg.history = { ...cfg.history, file: join(dir, 'data', 'history.jsonl') };
  cfg.notify = { ...cfg.notify, desktop: false };
  const hub = await startHub(cfg);
  const base = `http://127.0.0.1:${hub.port}`;
  const get = (p, headers = {}) => fetch(base + p, { headers });
  try {
    await new Promise(r => setTimeout(r, 400));
    await fn({ get, base, keys, token });
  } finally {
    await hub.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('machines are listed with what their facts say', () => withHub(async ({ get }) => {
  const list = await (await get('/api/machines')).json();
  assert.deepEqual(list.map(m => m.name), ['alpha', 'beta']);
  assert.equal(list[0].running, true);
  assert.equal(list[0].opencodeVersion, '1.18.35');
}));

test('state per machine, by query or by cookie; an unknown machine is 404', () => withHub(async ({ get }) => {
  const a = await (await get('/api/state?machine=alpha')).json();
  const b = await (await get('/api/state', { cookie: 'ocm_machine=beta' })).json();
  assert.deepEqual(a.sessions.map(s => s.title), ['alpha work']);
  assert.deepEqual(b.sessions.map(s => s.title), ['beta work']);
  assert.equal(a.central.machine, 'alpha');
  assert.deepEqual(a.central.machines, ['alpha', 'beta']);
  assert.equal((await get('/api/state?machine=gamma')).status, 404);
}));

test('the other answers are per machine too; replay and setup do not exist here', () => withHub(async ({ get }) => {
  assert.equal((await get('/api/stats?days=7&machine=alpha')).status, 200);
  assert.equal((await get('/api/tasks?days=7&machine=beta')).status, 200);
  assert.equal((await get('/api/costs?machine=alpha')).status, 200);
  for (const p of ['/api/replay?session=sa', '/api/replay/sessions', '/api/replay/days', '/api/setup']) assert.equal((await get(`${p}${p.includes('?') ? '&' : '?'}machine=alpha`)).status, 404, p);
  assert.equal((await get('/health')).status, 200);
}));

test('a sealed batch through /ingest shows up on the next reading', () => withHub(async ({ base, get, keys, token }) => {
  const env = seal({ machine: 'alpha', seq: 2, rows: { session: [sess('sa2', 'second job', '/alpha/shop')] }, facts: null }, keys.publicKey);
  const res = await fetch(`${base}/ingest`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(env) });
  assert.deepEqual(await res.json(), { ok: true, seq: 2 });
  await new Promise(r => setTimeout(r, 500));
  const a = await (await get('/api/state?machine=alpha')).json();
  assert.ok(a.sessions.some(s => s.title === 'second job'));
}));

test("the machine's model limits reach its sessions (context against the limit)", () => withHub(async ({ get }) => {
  const a = await (await get('/api/state?machine=alpha')).json();
  assert.equal(a.sessions[0].health.contextLimit, 131072);
}));

test('with central.influx set, an applied batch becomes points in InfluxDB', async () => {
  const { createServer } = await import('node:http');
  const got = [];
  const influx = createServer((req, res) => { let b = ''; req.on('data', c => (b += c)).on('end', () => { got.push({ url: req.url, auth: req.headers.authorization, body: b }); res.writeHead(204).end(); }); });
  await new Promise(r => influx.listen(0, '127.0.0.1', r));
  const dir = mkdtempSync(join(tmpdir(), 'ocm-hubinflux-'));
  const central = join(dir, 'central');
  const keys = initHubKeys(central);
  const token = issueToken(central, 'alpha');
  const cfg = structuredClone(DEFAULTS);
  Object.assign(cfg, { port: 0, pollMs: 200, dataDir: dir, opencodeConfigDir: dir });
  cfg.central = { ...cfg.central, dir: central, influx: { url: `http://127.0.0.1:${influx.address().port}`, org: 'home', bucket: 'opencode', token: 'w-tok' } };
  cfg.history = { ...cfg.history, file: join(dir, 'data', 'history.jsonl') };
  const hub = await startHub(cfg);
  try {
    const rows = { session: [sess('s9', 'job', '/alpha/shop')], message: [msg('m9', 's9')],
      part: [{ id: 'p9', message_id: 'm9', session_id: 's9', time_created: NOW - 3000, time_updated: NOW - 3000, data: JSON.stringify({ type: 'step-finish', cost: 0, tokens: { input: 70, output: 7, cache: { read: 50, write: 0 } } }) }] };
    const env = seal({ machine: 'alpha', seq: 1, rows, facts: { running: true, opencodeVersion: '2.0.29' } }, keys.publicKey);
    await fetch(`http://127.0.0.1:${hub.port}/ingest`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(env) });
    await new Promise(r => setTimeout(r, 700));
    const all = got.map(g => g.body).join('\n');
    assert.match(got[0].url, /bucket=opencode/);
    assert.equal(got[0].auth, 'Token w-tok');
    assert.match(all, /^opencode_request,machine=alpha,project=shop,provider=llama,model=qwen tokens_in=70/m);
    assert.match(all, /^opencode_version,machine=alpha version="2.0.29"/m);
    assert.doesNotMatch(all, /job/);
  } finally {
    await hub.close();
    await new Promise(r => influx.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});
