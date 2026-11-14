// OpenCode Central, hub side: /ingest takes sealed batches from machines that show their own token, writes them,
// and answers nothing but {ok, seq}. Anything else is refused before it is read or written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleIngest } from '../src/central/ingest.mjs';
import { issueToken, readTokens, initHubKeys, matchToken } from '../src/central/tokens.mjs';
import { createCentralStore } from '../src/central/store.mjs';
import { seal } from '../src/central/seal.mjs';

async function withHub(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ocm-ingest-'));
  const store = createCentralStore({ dir: join(dir, 'machines') });
  const keys = initHubKeys(dir);
  const token = issueToken(dir, 'poppy');
  const applied = [];
  const server = createServer((req, res) => handleIngest(req, res, { store, tokens: () => readTokens(dir), privateKey: keys.privateKey, maxBytes: 4096, onApplied: (b, m) => applied.push([m, b.seq]) }));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/ingest`;
  const post = (body, tok = token, extra = {}) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...extra }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  try {
    await fn({ dir, store, keys, token, post, url, applied });
  } finally {
    await new Promise(r => server.close(r));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
const batch = (seq, machine = 'poppy') => ({ machine, seq, sentAt: 1, rows: { session: [{ id: 's1', directory: '/poppy/x', title: 't', time_created: 1, time_updated: 1 }] }, facts: null });

test('a good batch: 200 {ok, seq}, rows stored, onApplied told', () => withHub(async ({ keys, post, store, applied }) => {
  const res = await post(seal(batch(1), keys.publicKey));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, seq: 1 });
  assert.equal(store.row('poppy', 'session', 's1').title, 't');
  assert.deepEqual(applied, [['poppy', 1]]);
  assert.deepEqual(await (await post(seal(batch(1), keys.publicKey))).json(), { ok: true, seq: 1 }, 'a replay is acknowledged');
  assert.equal(applied.length, 1, 'and not applied again');
}));

test('no token, a wrong one, or one replaced since: 401 and nothing written', () => withHub(async ({ dir, keys, post, store, token }) => {
  for (const tok of [null, 'nope', `${token}x`]) {
    const res = await post(seal(batch(1), keys.publicKey), tok);
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { ok: false });
  }
  issueToken(dir, 'poppy'); // replaces = revokes the old one
  assert.equal((await post(seal(batch(1), keys.publicKey), token)).status, 401);
  assert.deepEqual(store.machines(), []);
}));

test('too big: 413 before it is read', () => withHub(async ({ post }) => {
  const res = await post('x'.repeat(5000));
  assert.equal(res.status, 413);
}));

test('a broken envelope, or a batch for another machine: 400, nothing written', () => withHub(async ({ keys, post, store }) => {
  const env = seal(batch(1), keys.publicKey);
  for (const body of ['{not json', { ...env, tag: env.tag.replace(/^./, c => (c === 'A' ? 'B' : 'A')) }, seal(batch(1, 'other'), keys.publicKey)]) {
    const res = await post(body);
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { ok: false });
  }
  assert.deepEqual(store.machines(), []);
}));

test('only POST', () => withHub(async ({ url }) => {
  assert.equal((await fetch(url)).status, 405);
}));

test('tokens: only a hash is kept, the file is private, a match names the machine', () => withHub(async ({ dir, token }) => {
  const text = readFileSync(join(dir, 'tokens.json'), 'utf8');
  assert.equal(text.includes(token), false);
  assert.equal(matchToken(readTokens(dir), token), 'poppy');
  assert.equal(matchToken(readTokens(dir), 'nope'), null);
  if (process.platform !== 'win32') assert.equal(statSync(join(dir, 'tokens.json')).mode & 0o077, 0);
}));

test('hub keys are made once and kept', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ocm-keys-'));
  try {
    const a = initHubKeys(dir);
    const b = initHubKeys(dir);
    assert.equal(a.publicKey, b.publicKey);
    assert.equal(a.created, true);
    assert.equal(b.created, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('--central-init prints the public key once made; --central-token prints a token that matches', async () => {
  const { main } = await import('../src/main.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'ocm-oneoff-'));
  const cfgPath = join(dir, 'config.json');
  (await import('node:fs')).writeFileSync(cfgPath, JSON.stringify({ central: { dir: join(dir, 'central') } }));
  const lines = [];
  const log = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try {
    await main(['--central-init', '--config', cfgPath]);
    await main(['--central-token', 'poppy', '--config', cfgPath]);
  } finally { console.log = log; }
  try {
    const keys = initHubKeys(join(dir, 'central'));
    assert.ok(lines.some(l => l.includes(keys.publicKey)), 'public key printed');
    const token = lines.map(l => l.match(/token:\s*(\S+)/)?.[1]).find(Boolean);
    assert.equal(matchToken(readTokens(join(dir, 'central')), token), 'poppy');
    assert.equal(lines.join('\n').includes(keys.privateKey.split('.')[1]), false, 'the private key is never printed');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the hub refuses a batch that still carries text (an old or broken agent): 400, nothing written', () => withHub(async ({ keys, post, store }) => {
  const leaky = { machine: 'poppy', seq: 1, rows: { part: [{ id: 'p1', message_id: 'm1', session_id: 's1', time_created: 1, time_updated: 1,
    data: JSON.stringify({ type: 'text', text: 'here is the customer list:\nalice, bob' }) }] }, facts: null };
  assert.equal((await post(seal(leaky, keys.publicKey))).status, 400);
  const long = { ...leaky, rows: { part: [{ ...leaky.rows.part[0], data: JSON.stringify({ type: 'text', text: 'x'.repeat(300) }) }] } };
  assert.equal((await post(seal(long, keys.publicKey))).status, 400);
  assert.deepEqual(store.machines(), []);
  const fine = { ...leaky, rows: { part: [{ ...leaky.rows.part[0], data: JSON.stringify({ type: 'text', text: '·'.repeat(300) }) }] } };
  assert.equal((await post(seal(fine, keys.publicKey))).status, 200);
}));
