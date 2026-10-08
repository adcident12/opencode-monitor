// Starts the real server on sample data and talks to it over HTTP.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Ask the system for ports that are free right now instead of guessing numbers.
const freePort = () => new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});
const PORT = await freePort();
const OTHER_PORT = await freePort();

// fetch() will not let a test set the Host header, so use node:http directly.
function get(path, host = `127.0.0.1:${PORT}`) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: PORT, path, headers: { host } }, res => {
      let body = '';
      res.on('data', chunk => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('server: sample mode serves the page, the state, and the history; refuses foreign hosts', async () => {
  const child = spawn(process.execPath, ['server.mjs', '--sample', '--port', String(PORT)], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => (output += chunk));
  child.stderr.on('data', chunk => (output += chunk));
  try {
    const deadline = Date.now() + 60_000; // shared CI runners can be slow to start a process
    while (!output.includes(`:${PORT}`)) {
      assert.ok(child.exitCode == null && Date.now() < deadline, `server did not start:\n${output}`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.match(output, /SAMPLE DATA/);
    assert.match(output, /history: in memory only/);

    const state = JSON.parse((await get('/api/state')).body);
    assert.equal(state.sessions.length, 10);
    assert.equal(state.stale, false);
    assert.equal(state.historyCount, 9, 'one entry per top-level session');
    assert.equal(state.environment.mcp.length, 4);
    assert.ok(!/squ_[0-9a-f]{8}/.test(JSON.stringify(state)));

    assert.equal(JSON.parse((await get('/api/history')).body).length, 9);
    const page = await get('/');
    assert.equal(page.status, 200);
    assert.match(page.type, /text\/html/);
    for (const path of ['/app.js', '/style.css', '/i18n/en.json', '/i18n/th.json']) assert.equal((await get(path)).status, 200, path);

    assert.equal((await get('/i18n/../config.json')).status, 404);
    assert.equal((await get('/config.json')).status, 404);
    assert.equal((await get('/', 'evil.example')).status, 403);
  } finally {
    child.kill();
  }
});

test('server: clear messages for a missing database and a bad option', async () => {
  const run = args => new Promise(resolve => {
    const child = spawn(process.execPath, ['server.mjs', ...args], { cwd: ROOT });
    let err = '';
    child.stderr.on('data', chunk => (err += chunk));
    child.on('close', code => resolve({ code, err }));
  });
  const missing = await run(['--data-dir', join(ROOT, 'test', 'no-such-dir'), '--port', String(OTHER_PORT), '--no-notify']);
  assert.equal(missing.code, 1);
  assert.match(missing.err, /OpenCode database not found/);
  assert.ok(!missing.err.includes('    at '), 'no stack trace for an expected problem');
  assert.match((await run(['--bogus'])).err, /Unknown option --bogus/);
});
