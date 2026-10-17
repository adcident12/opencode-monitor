// What a llama.cpp server really runs, and where OpenCode thinks otherwise.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createEnvironment } from '../src/environment.mjs';
import { mismatchesOf, parseProps, propsUrl, resolveKey } from '../src/model-server.mjs';

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
