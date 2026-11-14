// OpenCode Central: what only the machine itself can see (the log, the process list, OpenCode 2's open prompts,
// each project's branch) travels as "facts", without patterns, messages or paths; the hub turns the facts back
// into objects with the same methods the monitor calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectFacts, createRemoteSources, LOG_METHODS } from '../src/central/facts.mjs';
import { UNREADABLE } from '../src/git.mjs';

const S = 'SECRET-q';
const hmacKey = Buffer.alloc(32, 2);
const conn = { t: 5, run: 'r1', name: 'github', directory: `C:\\${S}\\shop`, ok: false, tools: null, error: `${S} refused` };
const fakeLog = {
  poll() {},
  asks: () => [{ t: 1, run: 'r1', id: 'per_1', kind: 'permission', permission: 'bash', patterns: `rm -rf ${S}` }],
  replies: () => new Map([['que_1', 9]]),
  evictions: () => [{ t: 3, directory: `/home/${S}/web` }],
  opencodeVersion: () => '2.0.29',
  mcpDisconnected: () => [conn],
  mcpConnected: () => new Map([['jira', { t: 6, run: 'r1', name: 'jira', directory: 'C:/x/shop', ok: true, tools: 12, error: null }]]),
  runEnds: () => new Map([['r1', 99]]),
  mcpFailures: () => new Map([['github', { t: 5, run: 'r1', kind: 'closed', name: 'github' }]]),
  mcpEvents: () => [{ t: 5, run: 'r1', kind: 'closed', name: 'github', shutdown: false }],
  firstAt: () => 1,
  lastRun: () => 'r1',
  liveRuns: () => new Set(['r1']),
};
const fakePending = {
  check() {},
  asks: () => [{ t: 2, id: 'per_2', run: null, kind: 'permission', permission: 'edit', patterns: `/${S}.ts`, session: 'ses_1', part: 'prt_1', answeredAt: null }],
  replies: () => new Map([['per_0', 4]]),
};
const fakeGit = { refresh: async () => {}, get: dir => (dir === `C:\\${S}\\shop` ? { branch: 'main', detached: false, state: 'ok' } : UNREADABLE) };
const facts = () => collectFacts({ log: fakeLog, probe: { running: true }, pending: fakePending, git: fakeGit,
  directories: [`C:\\${S}\\shop`], machine: 'poppy', hmacKey, os: 'win32', now: 100 });

test('facts carry no patterns, messages or paths', () => {
  const f = facts();
  assert.doesNotMatch(JSON.stringify(f), /SECRET/);
  assert.equal(f.log.mcpDisconnected[0].directory, '/poppy/shop');
  assert.deepEqual(Object.keys(f.branches), ['/poppy/shop']);
  assert.equal(f.log.asks[0].permission, 'bash');
  assert.equal('patterns' in f.log.asks[0], false);
});

test('the hub gets back the same answers from the stand-ins', () => {
  const f = JSON.parse(JSON.stringify(facts())); // as it arrives, over the wire
  const { log, probe, pending, git } = createRemoteSources(() => f);
  assert.equal(probe.running, true);
  assert.equal(log.opencodeVersion(), '2.0.29');
  assert.equal(log.replies().get('que_1'), 9);
  assert.equal(log.mcpConnected().get('jira').tools, 12);
  assert.equal(log.liveRuns().has('r1'), true);
  assert.equal(log.runEnds().get('r1'), 99);
  assert.equal(log.mcpFailures().get('github').kind, 'closed');
  assert.equal(log.firstAt(), 1);
  assert.equal(pending.asks()[0].session, 'ses_1');
  assert.equal(pending.replies().get('per_0'), 4);
  assert.deepEqual(git.get('/poppy/shop'), { branch: 'main', detached: false, state: 'ok' });
  assert.deepEqual(git.get('/poppy/other'), UNREADABLE);
  pending.check(['ses_1']);
  log.poll();
});

test('no facts yet: OpenCode not known to run, no version, branches unreadable', () => {
  const { log, probe, git, pending } = createRemoteSources(() => null);
  assert.equal(probe.running, null);
  assert.equal(log.opencodeVersion(), null);
  assert.deepEqual(log.asks(), []);
  assert.deepEqual(pending.asks(), []);
  assert.deepEqual(git.get('/poppy/shop'), UNREADABLE);
});

test('the stand-in log has every method the monitor calls on a log', () => {
  const { log } = createRemoteSources(() => null);
  for (const m of LOG_METHODS) assert.equal(typeof log[m], 'function', m);
  for (const m of ['poll', 'asks', 'replies', 'evictions', 'opencodeVersion', 'mcpDisconnected', 'mcpConnected', 'runEnds', 'mcpFailures', 'mcpEvents', 'firstAt', 'lastRun', 'liveRuns'])
    assert.ok(LOG_METHODS.includes(m), m);
});

test('OpenCode\'s model limits and compaction settings travel as numbers and names only', () => {
  const f = collectFacts({ log: fakeLog, probe: { running: true }, pending: fakePending, git: fakeGit, directories: [], machine: 'poppy', hmacKey,
    opencode: { limits: new Map([['llama/qwen', 131072]]), reserves: new Map([['llama/qwen', { output: 8192, input: null, apiKey: S }]]),
      compaction: { auto: true, reserved: 20000, prompt: S }, outputTokenMax: 32000, model: 'llama/qwen', mcp: [{ name: 'x', command: S }] } });
  assert.deepEqual(f.opencode, { limits: [['llama/qwen', 131072]], reserves: [['llama/qwen', { output: 8192, input: null }]], compaction: { auto: true, reserved: 20000 }, outputTokenMax: 32000, model: 'llama/qwen' });
  assert.doesNotMatch(JSON.stringify(f), /SECRET/);
});
