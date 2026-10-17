// What a llama.cpp server really runs, and where OpenCode thinks otherwise.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createEnvironment } from '../src/environment.mjs';
import { mismatchesOf, parseProps, parseSlots, propsUrl, resolveKey, slotProgress } from '../src/model-server.mjs';
import { attachModelProgress } from '../src/monitor.mjs';

const PROPS = {
  default_generation_settings: { n_ctx: 65536 },
  total_slots: 1,
  model_path: 'C:\\models\\Qwen3.8-27B-iMatrix-NVFP4-MTP.gguf',
  model_alias: 'qwen3.8-27b-nvfp4-mtp',
  build_info: 'b11560-b13a93a3d',
};

test('the settings address is the root, not the OpenAI path', () => {
  assert.equal(propsUrl('http://192.168.0.53:11435/v1'), 'http://192.168.0.53:11435/props');
  assert.equal(propsUrl('http://h:1/v1/'), 'http://h:1/props');
  assert.equal(propsUrl('http://h:1'), 'http://h:1/props');
});

test('a key comes from where the config names it, never from the config itself', () => {
  assert.deepEqual(resolveKey('{env:LLAMA_KEY}', { LLAMA_KEY: ' sk-1 \n' }), { key: 'sk-1', problem: null });
  assert.deepEqual(resolveKey('{env:LLAMA_KEY}', {}), { key: null, problem: 'env_missing' });
  assert.deepEqual(resolveKey('{file:C:/k.txt}', {}, () => 'sk-2\n'), { key: 'sk-2', problem: null });
  assert.deepEqual(resolveKey('{file:C:/k.txt}', {}, () => { throw new Error('ENOENT'); }), { key: null, problem: 'file_unreadable' });
  assert.deepEqual(resolveKey('sk-plain', {}), { key: null, problem: 'not_a_reference' });
  assert.deepEqual(resolveKey(undefined), { key: null, problem: null });
});

test('the model it answers to is its alias; a file name alone names no model', () => {
  assert.deepEqual(parseProps(PROPS), { model: 'qwen3.8-27b-nvfp4-mtp', file: 'Qwen3.8-27B-iMatrix-NVFP4-MTP.gguf', nCtx: 65536, slots: 1, build: 'b11560-b13a93a3d' });
  assert.equal(parseProps({ ...PROPS, model_alias: PROPS.model_path }).model, null);
  assert.equal(parseProps({ error: 'x' }), null);
});

test('another model loaded, or a smaller context, for the models sessions ask for now', () => {
  const server = parseProps(PROPS);
  const contextOf = model => ({ 'bonsai2-27b': 131072, 'qwen3.8-27b-nvfp4-mtp': 131072 })[model] ?? null;
  assert.deepEqual(mismatchesOf(server, ['bonsai2-27b', 'bonsai2-27b'], contextOf), [
    { kind: 'model', asked: 'bonsai2-27b', loaded: 'qwen3.8-27b-nvfp4-mtp' },
    { kind: 'context', model: 'bonsai2-27b', opencode: 131072, server: 65536 },
  ]);
  // Same model, case aside; a window that fits.
  assert.deepEqual(mismatchesOf({ ...server, nCtx: 131072 }, ['Qwen3.8-27B-NVFP4-MTP'.toLowerCase()], contextOf), []);
  // Nothing asked now: nothing to compare.
  assert.deepEqual(mismatchesOf(server, [], contextOf), []);
});

test('the model-server check reads /props with the configured key, and says when it needs one', async () => {
  const server = createServer((req, res) => {
    if (req.url === '/health') return res.writeHead(200).end('{"status":"ok"}');
    if (req.url === '/props') {
      if (req.headers.authorization !== 'Bearer sk-test') return res.writeHead(401).end();
      return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(PROPS));
    }
    res.writeHead(404).end();
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const baseURL = `http://127.0.0.1:${server.address().port}/v1`;
  const make = keys => createEnvironment({
    cfg: { environment: { checkSeconds: 0, modelServers: 'local' }, services: [], modelServerKeys: keys },
    opencode: { providers: [{ id: 'local-llama', baseURL }], mcp: [], limits: new Map([['local-llama/bonsai2-27b', 131072]]) },
    log: { mcpFailures: () => new Map(), liveRuns: () => new Set() },
    probe: { running: true },
  });
  try {
    const keyed = make({ 'local-llama': '{env:OCM_TEST_LLAMA_KEY}' });
    process.env.OCM_TEST_LLAMA_KEY = 'sk-test';
    await keyed.refresh();
    const [model] = keyed.view(new Map(), [], new Map([['local-llama', ['bonsai2-27b']]])).models;
    assert.equal(model.ok, true);
    assert.equal(model.settings.model, 'qwen3.8-27b-nvfp4-mtp');
    assert.deepEqual(model.mismatches.map(m => m.kind), ['model', 'context']);

    const bare = make({});
    await bare.refresh();
    assert.equal(bare.view(new Map()).models[0].settings.status, 'needs_key');
  } finally {
    delete process.env.OCM_TEST_LLAMA_KEY;
    server.closeAllConnections();
    await new Promise(done => server.close(done));
  }
});

// From a real llama-server, a second apart: reading a 45k prompt from scratch, then writing.
const slot = (task, prompt, processed, written, busy = true) => ({ id: 0, is_processing: busy, id_task: task, n_prompt_tokens: prompt, n_prompt_tokens_processed: processed, n_prompt_tokens_cache: 0, next_token: [{ n_decoded: written }] });

test('a slot reading its prompt says how much so far and how fast, never a share: the total is not known yet', () => {
  const [a] = parseSlots([slot(128032, 26807, 24759, 0)]);
  const [b] = parseSlots([slot(128032, 28855, 26807, 0)]);
  assert.deepEqual(slotProgress(a), { phase: 'reading', read: 24759, cached: 0, rate: null });
  assert.deepEqual(slotProgress(b, a, 1500), { phase: 'reading', read: 26807, cached: 0, rate: 1365 });
  // Another request: no rate from the one before.
  assert.equal(slotProgress(b, { ...a, task: 1 }, 1500).rate, null);
});

test('a slot writing says how much and how fast; an idle one says nothing', () => {
  const [a] = parseSlots([slot(125186, 93435, 87424, 6012)]);
  const [b] = parseSlots([slot(125186, 93455, 87424, 6029)]);
  assert.deepEqual(slotProgress(b, a, 1000), { phase: 'writing', written: 6029, rate: 17 });
  assert.equal(slotProgress(parseSlots([slot(1, 0, 0, 0, false)])[0]), null);
  assert.equal(parseSlots({ error: 'x' }), null);
});

test('the progress goes on the one session waiting on that server, or on none', () => {
  const sessions = [{ id: 'a' }, { id: 'b' }];
  const env = progress => ({ models: [{ name: 'local-llama', live: progress }] });
  const reading = { phase: 'reading', read: 1000, cached: 0, rate: 900 };
  attachModelProgress(sessions, new Map([['local-llama', ['a']]]), env({ progress: [reading], idleMs: null }));
  assert.deepEqual(sessions[0].modelProgress, reading);
  // Two waiting on one server: which slot serves which is not known.
  const two = [{ id: 'a' }, { id: 'b' }];
  attachModelProgress(two, new Map([['local-llama', ['a', 'b']]]), env({ progress: [reading], idleMs: null }));
  assert.equal(two[0].modelProgress, undefined);
  // Waited on and idle: said only after a minute.
  const idle = [{ id: 'a' }];
  attachModelProgress(idle, new Map([['local-llama', ['a']]]), env({ progress: [], idleMs: 30_000 }));
  assert.equal(idle[0].modelProgress, undefined);
  attachModelProgress(idle, new Map([['local-llama', ['a']]]), env({ progress: [], idleMs: 90_000 }));
  assert.deepEqual(idle[0].modelProgress, { phase: 'idle', idleMs: 90_000 });
});

test('slots are read only while a session waits on the server', async () => {
  let asked = 0;
  const server = createServer((req, res) => {
    if (req.url === '/health') return res.writeHead(200).end('{}');
    if (req.url === '/props') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(PROPS));
    if (req.url === '/slots') {
      asked++;
      return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify([slot(7, 2048, 2048, 0)]));
    }
    res.writeHead(404).end();
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const baseURL = `http://127.0.0.1:${server.address().port}/v1`;
  try {
    const env = createEnvironment({
      cfg: { environment: { checkSeconds: 0, modelServers: 'local' }, services: [], modelServerKeys: {} },
      opencode: { providers: [{ id: 'local-llama', baseURL }], mcp: [], limits: new Map() },
      log: { mcpFailures: () => new Map(), liveRuns: () => new Set() },
      probe: { running: true },
    });
    await env.refresh();
    env.view(new Map());
    await env.refresh();
    assert.equal(asked, 0);
    env.view(new Map(), [], new Map(), new Map([['local-llama', ['a']]]));
    await env.refresh();
    await new Promise(done => setTimeout(done, 50));
    const [model] = env.view(new Map(), [], new Map(), new Map([['local-llama', ['a']]])).models;
    assert.equal(asked, 1);
    assert.deepEqual(model.live.progress, [{ phase: 'reading', read: 2048, cached: 0, rate: null }]);
  } finally {
    server.closeAllConnections();
    await new Promise(done => server.close(done));
  }
});
