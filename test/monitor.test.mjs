// End to end against the generated sample data: database + log -> snapshot.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildSample } from '../scripts/make-sample.mjs';
import { openDb } from '../src/db.mjs';
import { createLogTail, parseAskLine } from '../src/logtail.mjs';
import { createMonitor } from '../src/monitor.mjs';
import { createRedactor } from '../src/redact.mjs';
import { createNotifier } from '../src/notify.mjs';
import { stripJsonc, loadOpencodeConfig } from '../src/opencode-config.mjs';
import { createEnvironment } from '../src/environment.mjs';
import { matchProcesses } from '../src/process.mjs';
import { DEFAULTS, loadConfig } from '../src/config.mjs';

const NOW = Date.now();
let dir, db, snap;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'ocm-'));
  buildSample(join(dir, 'data'), NOW);
  db = openDb(join(dir, 'data'));
  const log = createLogTail(join(dir, 'data', 'log', 'opencode.log'));
  const probe = { running: true };
  const opencode = loadOpencodeConfig(join(dir, 'data'), { XDG_CACHE_HOME: join(dir, 'none') });
  const monitor = createMonitor({
    db, log, probe,
    cfg: { ...DEFAULTS, environment: { checkSeconds: 15, modelServers: 'off' } },
    redact: createRedactor(),
    modelLimits: opencode.limits,
    mcpNames: opencode.mcp.map(s => s.name),
    environment: createEnvironment({ cfg: { ...DEFAULTS, environment: { checkSeconds: 15, modelServers: 'off' } }, opencode, log, probe }),
  });
  snap = monitor(NOW);
});

after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const byTitle = start => snap.sessions.find(s => s.title.startsWith(start));

test('each sample session lands in the expected state', () => {
  const expected = {
    'Add pagination': ['working', 'tool'],
    'Wire up the staging': ['waiting', 'permission'],
    'Choose a date library': ['waiting', 'question'],
    'Fix the login redirect': ['stuck', 'tool_long'],
    'Rename UserCard': ['finished', 'done'],
    'Generate the OpenAPI': ['error', 'message_error'],
    'Migrate reports': ['working', 'tool'],
    'Audit dependencies': ['waiting', 'child_waiting'],
    'Check outdated packages': ['waiting', 'permission'],
  };
  for (const [title, [state, reason]] of Object.entries(expected)) {
    const s = byTitle(title);
    assert.deepEqual([s.state, s.reason], [state, reason], title);
  }
  assert.equal(snap.sessions.length, 10);
  assert.equal(snap.stale, false);
});

test('the overnight permission prompt keeps its age and details', () => {
  const s = byTitle('Wire up the staging');
  assert.equal(s.prompt.permission, 'read');
  assert.equal(s.prompt.detail, '/work/clinic-app/.env');
  assert.ok(NOW - s.since >= 8 * 3_600_000);
});

test('progress: output of the running command, latest steps, and the task list', () => {
  const working = byTitle('Add pagination');
  assert.equal(working.current.output.lines.at(-1), ' ❯ orders/export.test.ts 3/11');
  assert.equal(working.current.output.at, NOW - 4000);
  assert.equal(working.progress.lastActivityAt, NOW - 4000);
  assert.deepEqual(working.progress.steps.map(s => [s.tool, s.status]), [['graft_graft_find_code', 'completed'], ['read', 'completed'], ['edit', 'completed'], ['bash', 'error'], ['bash', 'running']]);
  assert.equal(working.progress.steps[1].durationMs, 900);
  assert.deepEqual(working.progress.todos, { done: 2, total: 4, current: 'Run the orders tests and fix failures' });

  const stuck = byTitle('Fix the login redirect');
  assert.ok(NOW - stuck.current.output.at > 34 * 60_000, 'the hung command printed its last line long ago');
  assert.equal(byTitle('Rename UserCard').progress.todos, null);
});

test('review: flagged calls with who approved them, and no secret in the listing', () => {
  const review = byTitle('Clean up the release branch').review;
  assert.deepEqual(review.counts, { risky: 3, secret_value: 1, secret_file: 1, outbound: 2, background: 0 });
  const find = rule => review.items.find(i => i.rule === rule);
  assert.equal(find('git_force_push').approval, 'you');
  assert.equal(find('kill_process').approval, 'rule');
  assert.equal(find('delete_recursive').approval, 'denied');
  assert.equal(find('http_request').host, 'registry.example.com');
  assert.equal(find('in_output').tool, 'read');
  assert.equal(byTitle('Rename UserCard').review.total, 0);
});

test('work: files the agent touched', () => {
  const work = byTitle('Clean up the release branch').work;
  assert.deepEqual(work.files, { count: 1, recent: ['src/release.ts'] });
  assert.equal(work.git, null, 'no git probe in this test');
});

test('environment: MCP status from the log and from tool calls', () => {
  const status = Object.fromEntries(snap.environment.mcp.map(m => [m.name, [m.status, m.kind]]));
  assert.deepEqual(status, {
    'chrome-devtools': ['failed', 'closed'],
    graft: ['ok', null],
    sonarqube: ['failed', 'unavailable'],
    github: ['disabled', null],
  });
  assert.deepEqual(snap.environment.models, [], 'model checks are off in this test');
});

test('session health shows up', () => {
  const h = byTitle('Migrate reports').health;
  assert.equal(h.contextPct, 92);
  assert.equal(h.compactions, 19);
  assert.equal(h.repeat.count, 5);
  assert.ok(h.suggestNewSession);
});

test('no secret-shaped value reaches the snapshot', () => {
  const json = JSON.stringify(snap);
  assert.ok(!/squ_[0-9a-f]{8}/.test(json));
  assert.ok(byTitle('Migrate reports').current.summary.includes('[redacted]'));
});

test('a second poll with no changes gives the same sessions', () => {
  const again = createMonitor({
    db, log: createLogTail(join(dir, 'data', 'log', 'opencode.log')), cfg: { ...DEFAULTS, contextLimit: { default: 131_072, models: {} } },
    redact: createRedactor(), modelLimits: new Map(), probe: { running: true },
  });
  assert.deepEqual(again(NOW).sessions, again(NOW).sessions);
});

test('a database with an unexpected layout is refused with a clear message', () => {
  const bad = join(dir, 'bad');
  mkdirSync(bad);
  const raw = new DatabaseSync(join(bad, 'opencode.db'));
  raw.exec('create table session (id text primary key, title text); create table message (id text); create table part (id text)');
  raw.close();
  assert.throws(() => openDb(bad), /column "session\.time_updated" is missing/);
  assert.throws(() => openDb(join(dir, 'nowhere')), /not found/);
});

test('log lines: real prompts parse, look-alikes inside commands do not', () => {
  const ask = parseAskLine('timestamp=2026-10-07T15:20:01.123Z level=INFO run=ab12cd34 message=asking id=per_abc permission=bash patterns="[\\"npm run dev\\"]"');
  assert.deepEqual(ask, { t: Date.parse('2026-10-07T15:20:01.123Z'), id: 'per_abc', kind: 'permission', permission: 'bash', patterns: 'npm run dev' });
  assert.equal(parseAskLine('timestamp=2026-10-07T15:20:01.123Z level=INFO run=ab12cd34 message=asking id=que_abc questions=1').kind, 'question');
  assert.equal(parseAskLine('timestamp=2026-10-07T15:20:01.123Z level=INFO run=ab12cd34 message=evaluated permission=bash pattern="echo message=asking id=per_fake"'), null);
});

test('the log tail picks up appended lines and survives truncation', () => {
  const path = join(dir, 'tail.log');
  const line = n => `timestamp=2026-10-07T15:20:0${n}.000Z level=INFO run=ab12cd34 message=asking id=per_${n} permission=bash patterns="[]"\n`;
  writeFileSync(path, line(1));
  const tail = createLogTail(path);
  tail.poll();
  assert.equal(tail.asks().length, 1);
  writeFileSync(path, line(1) + line(2) + 'timestamp=2026-10-07T15:20:03.000Z level=INFO run=ab12cd34 message=asking id=per_3 perm');
  tail.poll();
  assert.equal(tail.asks().length, 2, 'the unfinished last line waits for its newline');
  writeFileSync(path, line(4));
  tail.poll();
  assert.deepEqual(tail.asks().map(a => a.id), ['per_4']);
});

test('notifier: silent at start, fires on change, repeats, reports subagents once', () => {
  const sent = [];
  const send = { desktop: (title, body) => sent.push(['desktop', title, body]), discord: (url, content) => sent.push(['discord', content]) };
  const cfg = { on: ['waiting', 'stuck'], repeatMinutes: 30, desktop: true, discord: { webhookUrl: 'https://discord.com/api/webhooks/1/x', mention: '<@42>', includeDetail: false } };
  const notify = createNotifier(cfg, (key, vars = {}) => `${key}${vars.t ? ` ${vars.t}` : ''}`, send);
  const s = (id, state, extra = {}) => ({ id, parentId: null, state, since: 0, project: 'shop', title: `T-${id}`, prompt: { detail: 'rm -rf build' }, ...extra });
  const T = 10_000_000;

  notify([s('a', 'waiting'), s('b', 'working')], T);
  assert.equal(sent.length, 0, 'what is already there at startup is not news');

  notify([s('a', 'waiting'), s('b', 'stuck'), s('c', 'waiting', { parentId: 'b' })], T + 2000);
  assert.deepEqual(sent.map(x => x[0]), ['desktop', 'discord']);
  assert.match(sent[1][1], /<@42>\n\*\*notify\.stuck\*\*\nshop — T-b/);
  assert.ok(!sent[1][1].includes('rm -rf'), 'detail stays local unless includeDetail is on');

  sent.length = 0;
  notify([s('a', 'waiting'), s('b', 'stuck')], T + 29 * 60_000);
  assert.equal(sent.length, 0);
  notify([s('a', 'waiting'), s('b', 'stuck')], T + 30 * 60_000 + 1000);
  assert.equal(sent.filter(x => x[0] === 'desktop').length, 1, 'reminder for the prompt that predates the monitor');
  notify([s('a', 'waiting'), s('b', 'stuck')], T + 33 * 60_000);
  assert.equal(sent.filter(x => x[0] === 'desktop').length, 2, 'reminder for the one that started later');
});

test('config: JSONC parsing, process matching, webhook validation', () => {
  assert.deepEqual(JSON.parse(stripJsonc('{ // note\n "a": "x // y", /* b */ "c": [1, 2,], }')), { a: 'x // y', c: [1, 2] });
  assert.equal(matchProcesses('"opencode.exe","14056","Console","1","512 K"\n', ['opencode'], 'win32'), true);
  assert.equal(matchProcesses('"node.exe","1","Console","1","512 K"\n', ['opencode'], 'win32'), false);
  assert.equal(matchProcesses(' 10 /usr/local/bin/opencode\n', ['opencode'], 'linux', 1), true);
  assert.equal(matchProcesses(' 10 node /home/u/.npm/bin/opencode --port 0\n', ['opencode'], 'linux', 1), true);
  assert.equal(matchProcesses(' 10 node /srv/opencode-monitor/server.mjs --data-dir /x/opencode\n', ['opencode'], 'linux', 1), false);
  assert.throws(() => loadConfig({}, { OPENCODE_MONITOR_DISCORD_WEBHOOK: 'https://example.com/hook' }), /Discord webhook/);
});
