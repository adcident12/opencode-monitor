// Starts the real server on sample data and talks to it over HTTP.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
const INNER_PORT = await freePort();

// fetch() will not let a test set the Host header, so use node:http directly.
function get(path, host = null, port = PORT) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers: { host: host ?? `127.0.0.1:${port}` } }, res => {
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
    // The sample's config is fake, so no config file is watched and nothing is kept.
    assert.deepEqual(JSON.parse((await get('/api/config-changes?days=14')).body), []);
    const stats = JSON.parse((await get('/api/stats?days=7')).body);
    assert.equal(stats.daily.length, 7);
    assert.ok(Array.isArray(stats.takeaways));
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

/** Runs `fn` with what it prints collected instead of shown. */
async function printed(fn) {
  const lines = [];
  const { log, warn } = console;
  console.log = (...parts) => lines.push(parts.join(' '));
  console.warn = (...parts) => lines.push(parts.join(' '));
  try {
    const result = await fn();
    return { result, text: lines.join('\n') };
  } finally {
    Object.assign(console, { log, warn });
  }
}

// The same monitor inside this process, so that it can be stopped: what the spawned one
// above cannot show is that it lets go of everything when asked.
test('server: started and stopped in this process; every address answers', async () => {
  const { main } = await import('../src/main.mjs');
  const here = (path, host = null) => get(path, host, INNER_PORT);
  const { result: monitor, text } = await printed(() => main(['--sample', '--port', String(INNER_PORT)]));
  try {
    assert.equal(monitor.port, INNER_PORT);
    assert.match(text, /SAMPLE DATA/);
    assert.match(text, /history: in memory only\n {2}notifications: off/);

    for (const path of ['/api/state', '/api/stats?days=14', '/api/setup', '/api/history?limit=2&attention=1', '/api/history/sessions', '/api/config-changes']) {
      const res = await here(path);
      assert.deepEqual([res.status, res.type], [200, 'application/json; charset=utf-8'], path);
      JSON.parse(res.body);
    }
    assert.equal(JSON.parse((await here('/api/history?limit=2')).body).events.length, 2);
    // Replay: the sessions to choose from, then one of them, and nothing for an id that is not one.
    const choices = JSON.parse((await here('/api/replay/sessions')).body);
    assert.ok(choices.length > 0);
    const played = JSON.parse((await here('/api/replay?session=' + choices[0].id)).body);
    assert.equal(played.session.id, choices[0].id);
    assert.ok(played.rows[0].segs.length > 0);
    assert.equal((await here('/api/replay?session=no-such')).body, 'null');
    assert.equal((await here('/api/replay?session=' + encodeURIComponent('../x'))).body, 'null');
    const page = await here('/');
    assert.equal(page.status, 200);
    assert.match(page.csp, /default-src/);
    assert.equal((await here('/no-such-file')).status, 404);
    assert.equal((await here('/api/nope')).status, 404);
    assert.equal((await here('/', 'evil.example')).status, 403);
    // "constructor" is a property of every object; it must not be taken for an address.
    assert.equal((await here('/constructor')).status, 404);

    // The live stream sends the state at once.
    const first = await new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: INNER_PORT, path: '/api/events', headers: { host: `127.0.0.1:${INNER_PORT}` } }, res => {
        res.once('data', chunk => {
          resolve({ type: res.headers['content-type'], chunk: String(chunk) });
          req.destroy();
        });
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(first.type, 'text/event-stream; charset=utf-8');
    assert.match(first.chunk, /^data: \{/);
  } finally {
    await monitor.close();
  }
  // Stopped: the port is free again.
  await assert.rejects(here('/api/state'), /ECONNREFUSED/);
  const again = createServer();
  await new Promise((resolve, reject) => again.once('error', reject).listen(INNER_PORT, '127.0.0.1', resolve));
  await new Promise(resolve => again.close(resolve));
});

test('the options that print and are done: --version, --help, --doctor', async () => {
  const { main } = await import('../src/main.mjs');
  const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.equal((await printed(() => main(['--version']))).text, version);
  assert.match((await printed(() => main(['--help']))).text, /--data-dir <path>/);
  // A data directory with no database: the report still comes, and says what is missing.
  // Its own empty settings file, so the test does not depend on this machine's config.json.
  const settings = join(mkdtempSync(join(tmpdir(), 'ocm-doctor-')), 'config.json');
  writeFileSync(settings, '{}');
  const doctor = await printed(() => main(['--doctor', '--config', settings, '--data-dir', join(ROOT, 'test', 'no-such-dir'), '--no-notify']));
  assert.equal(doctor.result, undefined);
  assert.match(doctor.text, /opencode\.db/);
  assert.match(doctor.text, /Weekly summary: off/);
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

test('string files: no key is defined twice, and both languages have the same keys', () => {
  for (const name of ['en', 'th']) {
    const text = readFileSync(join(ROOT, 'i18n', `${name}.json`), 'utf8');
    // JSON.parse keeps the last of two equal keys without a word; count them in the text instead.
    const keys = [...text.matchAll(/^\s*"([^"]+)":/gm)].map(m => m[1]);
    const twice = keys.filter((k, i) => keys.indexOf(k) !== i);
    assert.deepEqual(twice, [], `${name}.json defines these more than once`);
  }
  const en = Object.keys(JSON.parse(readFileSync(join(ROOT, 'i18n', 'en.json'), 'utf8')));
  const th = Object.keys(JSON.parse(readFileSync(join(ROOT, 'i18n', 'th.json'), 'utf8')));
  assert.deepEqual(en.filter(k => !th.includes(k)), [], 'missing from th.json');
  assert.deepEqual(th.filter(k => !en.includes(k)), [], 'missing from en.json');
});
