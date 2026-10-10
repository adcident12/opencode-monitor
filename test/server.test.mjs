// Starts the real server on sample data and talks to it over HTTP.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { readFileSync } from 'node:fs';
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
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], csp: res.headers['content-security-policy'], body }));
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
    // Startup prints several lines that can arrive in separate chunks; "notifications:" is the last.
    while (!output.includes('notifications:')) {
      assert.ok(child.exitCode == null && Date.now() < deadline, `server did not start:\n${output}`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.match(output, /SAMPLE DATA/);
    // One version, from package.json: in the startup line and in what the page is sent.
    const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    assert.match(version, /^\d+\.\d+\.\d+$/);
    assert.ok(output.includes(`opencode-monitor ${version}: http://127.0.0.1:${PORT}`), output);
    assert.match(output, /history: in memory only/);

    const state = JSON.parse((await get('/api/state')).body);
    assert.equal(state.sessions.length, 10);
    assert.equal(state.stale, false);
    assert.equal(state.version, version);
    assert.equal(state.historyCount, 9, 'one entry per top-level session');
    assert.equal(state.environment.mcp.length, 4);
    // The build the server is serving, so an open page can tell when it is out of date.
    assert.equal(state.build, JSON.parse(readFileSync(join(ROOT, 'public', 'build.json'), 'utf8')).id);
    assert.ok(!/squ_[0-9a-f]{8}/.test(JSON.stringify(state)));

    const history = JSON.parse((await get('/api/history')).body);
    assert.deepEqual([history.events.length, history.more, history.truncated], [9, 0, false]);
    const firstFour = JSON.parse((await get('/api/history?limit=4')).body);
    const rest = JSON.parse((await get(`/api/history?limit=100&before=${firstFour.events.at(-1).t}:${firstFour.events.at(-1).id}`)).body);
    assert.deepEqual([firstFour.more, rest.events.length], [5, 5]);
    const stats = JSON.parse((await get('/api/stats?days=7')).body);
    assert.equal(stats.daily.length, 7);
    assert.ok(stats.totals.prompts >= 2, 'the sample prompts are counted');
    assert.equal(JSON.parse((await get('/api/stats?days=999')).body).daily.length, 14, 'unknown ranges fall back to 14 days');
    assert.ok(!/squ_[0-9a-f]{8}/.test(JSON.stringify(stats)));
    const page = await get('/');
    assert.equal(page.status, 200);
    assert.match(page.type, /text\/html/);
    for (const path of ['/i18n/en.json', '/i18n/th.json']) assert.equal((await get(path)).status, 200, path);
    // Every script and stylesheet the page refers to is served.
    const assets = [...page.body.matchAll(/(?:src|href)="(\/_next\/[^"?]+)/g)].map(m => m[1]);
    assert.ok(assets.length > 3);
    for (const path of new Set(assets)) assert.equal((await get(path)).status, 200, path);

    // The page's policy allows its own inline scripts by hash and nothing inline beyond that.
    assert.match(page.csp, /script-src 'self'( 'sha256-[^']+')+;/);
    assert.ok(!/script-src[^;]*unsafe-inline/.test(page.csp));

    for (const path of ['/i18n/../config.json', '/config.json', '/../config.json', '/%2e%2e/config.json', '/_next/..%2f..%2fconfig.json', '/..%5cconfig.json', '/server.mjs', '/src/main.mjs']) {
      assert.equal((await get(path)).status, 404, path);
    }
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
