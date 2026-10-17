// What is asked of a model server, and what counts as it being up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createEnvironment, healthUrl } from '../src/environment.mjs';
import { DEFAULTS } from '../src/config.mjs';

test('a model server is asked for its health address, whatever its baseURL ends with', () => {
  assert.equal(healthUrl('http://127.0.0.1:11435/v1'), 'http://127.0.0.1:11435/v1/health');
  assert.equal(healthUrl('http://127.0.0.1:11435/v1/'), 'http://127.0.0.1:11435/v1/health');
});

test('up: any answer below 500, with no key sent, the list of models never asked for, and settings asked once', async () => {
  const asked = [];
  const answers = { '/up/health': 200, '/nokey/health': 401, '/none/health': 404, '/loading/health': 503 };
  const server = createServer((req, res) => {
    asked.push([req.url, req.headers.authorization ?? null]);
    res.writeHead(answers[req.url] ?? 500).end();
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const providers = ['up', 'nokey', 'none', 'loading'].map(id => ({ id, baseURL: `${base}/${id}/` }));
    const environment = createEnvironment({
      cfg: { ...DEFAULTS, environment: { checkSeconds: 0, modelServers: 'local' }, services: [] },
      opencode: { providers, mcp: [] },
      log: { mcpFailures: () => new Map(), liveRuns: () => new Set() },
      probe: { running: true },
    });
    await environment.refresh();
    const models = Object.fromEntries(environment.view(new Map(), []).models.map(m => [m.name, m.ok]));
    assert.deepEqual(models, { up: true, nokey: true, none: true, loading: false });
    // Settings of the servers that are up; each refused, so none is asked again.
    await environment.refresh();
    assert.deepEqual(asked.map(a => a[0]).sort(), ['/loading/health', '/loading/health', '/nokey/health', '/nokey/health', '/nokey/props', '/none/health', '/none/health', '/none/props', '/up/health', '/up/health', '/up/props']);
    assert.ok(!asked.some(a => /models/.test(a[0])));
    assert.ok(asked.every(a => a[1] === null));
  } finally {
    server.close();
  }
});
