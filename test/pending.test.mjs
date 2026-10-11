// What OpenCode 2 is waiting for you to allow: asked of OpenCode, since nothing records it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPending, promptsFor, questionsOf, timeOfId, withPending } from '../src/pending.mjs';
import { deriveState } from '../src/state.mjs';
import { approvalOf } from '../src/audit.mjs';
import { matchPrompts } from '../src/stats.mjs';
import { DEFAULTS } from '../src/config.mjs';

const T = 1_791_696_573_065; // when per_129701289001… was made, as OpenCode's own id says
const ASK_ID = 'per_129701289001s4eA8kGnRVDxHb';
const request = (id = ASK_ID, part = 'call1') => ({ id, sessionID: 's1', action: 'read', resources: ['.env'], save: ['*'], source: { type: 'tool', messageID: 'm1', id: part } });
const settle = () => new Promise(done => setImmediate(done));

/** A stand-in for `opencode api`: answers each session from `lists`, and counts the calls. */
function fakeRun(lists) {
  const calls = [];
  const run = async (command, args) => {
    calls.push([command, ...args].join(' '));
    const session = args.at(-1).replace('sessionID=', '');
    const list = lists[session];
    if (list instanceof Error) throw list;
    return JSON.stringify({ data: list ?? [] });
  };
  return { run, calls };
}

test('the time a request was made is in its id', () => {
  assert.equal(timeOfId(ASK_ID, T + 5000), T);
  assert.equal(timeOfId('msg_1292ec995001l5MRZ67HFjmlmY', T), 1_791_692_294_549);
  // Read against the present: an id of two years ago is not taken for one of the future.
  assert.ok(timeOfId(ASK_ID, T + 5000) <= T + 5000);
  assert.equal(timeOfId('not an id', T), null);
  assert.equal(timeOfId('per_zzzzzzzzzzzz', T), null);
});

test('a session with a running call is asked about: a prompt appears, and is closed when it is no longer listed', async () => {
  const lists = { s1: [request()] };
  const { run, calls } = fakeRun(lists);
  const pending = createPending({ run });
  pending.check(['s1'], T + 3000);
  await settle();
  assert.deepEqual(calls, ['opencode api session.permission.list --param sessionID=s1']);
  assert.deepEqual(pending.asks(), [{ t: T, run: null, id: ASK_ID, kind: 'permission', permission: 'read', patterns: '.env', session: 's1', part: 'call1', answeredAt: null }]);
  assert.equal(pending.status().ok, true);

  // Not asked again before its time, however often the page is read.
  pending.check(['s1'], T + 4000);
  await settle();
  assert.equal(calls.length, 1);

  // Answered: OpenCode no longer lists it.
  lists.s1 = [];
  pending.check(['s1'], T + 9000);
  await settle();
  assert.equal(pending.asks()[0].answeredAt, T + 9000);
  assert.deepEqual([...pending.replies()], [[ASK_ID, T + 9000]]);
});

test('not knowing is not an answer: a failed listing closes nothing, and says so', async () => {
  const lists = { s1: [request()] };
  const { run } = fakeRun(lists);
  const pending = createPending({ run });
  pending.check(['s1'], T + 3000);
  await settle();
  lists.s1 = Object.assign(new Error('spawn opencode ENOENT'), { code: 'ENOENT' });
  pending.check(['s1'], T + 9000);
  await settle();
  assert.equal(pending.asks()[0].answeredAt, null);
  assert.deepEqual(pending.status(), { enabled: true, ok: false, error: 'ENOENT', at: T + 9000 });

  // The session has no call running any more: whatever it waited for is over.
  pending.check([], T + 20_000);
  assert.equal(pending.asks()[0].answeredAt, T + 20_000);
});

test('a call that runs on is asked about less and less often', async () => {
  const { run, calls } = fakeRun({ s1: [] });
  const pending = createPending({ run });
  const SECOND = 1000;
  const asked = async until => {
    for (let t = 0; t <= until; t += SECOND) {
      pending.check(['s1'], T + t);
      await settle();
    }
    return calls.length;
  };
  // Every 5 seconds for two minutes, every 15 for half an hour, then once a minute.
  assert.equal(await asked(119 * SECOND), 24);
  calls.length = 0;
  const hour = fakeRun({ s1: [] });
  const long = createPending({ run: hour.run });
  for (let t = 0; t <= 3600 * SECOND; t += SECOND) {
    long.check(['s1'], T + t);
    await settle();
  }
  assert.equal(hour.calls.length, 24 + 112 + 30);
  // A new call of the session starts the close look again.
  long.check([], T + 3601 * SECOND);
  long.check(['s1'], T + 3602 * SECOND);
  await settle();
  long.check(['s1'], T + 3607 * SECOND);
  await settle();
  assert.equal(hour.calls.length, 24 + 112 + 30 + 2);
});

test('what a prompt asks for is kept with its secrets hidden', async () => {
  const secret = { ...request(), action: 'bash', resources: ['curl -H "Authorization: Bearer abc123" https://x'] };
  const pending = createPending({ run: fakeRun({ s1: [secret] }).run, redact: text => text.replace(/Bearer \w+/, 'Bearer ***') });
  pending.check(['s1'], T + 3000);
  await settle();
  assert.equal(pending.asks()[0].patterns, 'curl -H "Authorization: Bearer ***" https://x');
});

test('nothing is run when it is switched off, for an id that is not one, or for more sessions than a few', async () => {
  const off = fakeRun({});
  createPending({ run: off.run, enabled: false }).check(['s1'], T);
  const odd = fakeRun({});
  createPending({ run: odd.run }).check(['s1; rm -rf /', 's 1', '$(x)'], T);
  const many = fakeRun({});
  createPending({ run: many.run }).check(Array.from({ length: 20 }, (_, i) => `s${i}`), T);
  await settle();
  assert.deepEqual([off.calls.length, odd.calls.length, many.calls.length], [0, 0, 6]);
});

test('prompts are kept in a file: still there after a restart, and read by a process that never asks', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ocm-pending-'));
  const file = join(dir, 'prompts.jsonl');
  try {
    const lists = { s1: [request()] };
    const first = createPending({ run: fakeRun(lists).run, file });
    first.check(['s1'], T + 3000);
    await settle();
    lists.s1 = [];
    first.check(['s1'], T + 9000);
    await settle();
    assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 2);

    const reader = fakeRun({});
    const second = createPending({ run: reader.run, file, readOnly: true });
    assert.deepEqual(second.asks().map(a => [a.id, a.t, a.part, a.answeredAt]), [[ASK_ID, T, 'call1', T + 9000]]);
    second.check(['s1'], T + 60_000);
    await settle();
    assert.equal(reader.calls.length, 0);

    // Past its time, or not a prompt at all: dropped when the file is next read by its owner.
    writeFileSync(file, `${JSON.stringify({ t: 5, id: 'per_old', kind: 'permission' })}\nnot json\n${readFileSync(file, 'utf8')}`);
    assert.deepEqual(createPending({ run: reader.run, file }).asks().map(a => a.id), [ASK_ID]);
    assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a pending prompt makes its session wait, by the call it names and not by the clock', async () => {
  const pending = createPending({ run: fakeRun({ s1: [request(ASK_ID, 'call1')] }).run });
  pending.check(['s1'], T + 3000);
  await settle();
  const log = withPending({ asks: () => [{ t: T - 60_000, kind: 'permission', id: 'per_log', permission: 'bash', patterns: 'ls', run: 'r' }], replies: () => new Map(), poll() {} }, pending);
  assert.deepEqual(log.asks().map(a => a.id), ['per_log', ASK_ID]);

  const session = { id: 's1', time_created: T - 100_000 };
  const messages = [{ id: 'u', role: 'user', time_created: T - 90_000 }, { id: 'm1', role: 'assistant', time_created: T - 80_000, completed: null }];
  // The call was last touched a minute after the prompt: by the clock alone it would not match.
  const call = { id: 'call1', message_id: 'm1', type: 'tool', tool: 'read', status: 'running', time_created: T - 500, time_updated: T + 60_000, started: T - 100 };
  const state = now => deriveState({ session, parts: [call], messages, asks: log.asks(), now, thresholds: DEFAULTS.thresholds, opencodeRunning: true });
  assert.deepEqual((({ state: s, reason, since, prompt }) => [s, reason, since, prompt])(state(T + 70_000)), ['waiting', 'permission', T, { kind: 'permission', permission: 'read', detail: '.env' }]);
  // One script's MCP calls share the script's prompt.
  assert.equal(deriveState({ session, parts: [{ ...call, id: 'call1:0' }], messages, asks: log.asks(), now: T + 70_000, thresholds: DEFAULTS.thresholds, opencodeRunning: true }).state, 'waiting');
  // Another call of the same session, running at the very same moment, is not waiting.
  assert.equal(deriveState({ session, parts: [{ ...call, id: 'call2', time_updated: T }], messages, asks: log.asks(), now: T + 70_000, thresholds: DEFAULTS.thresholds, opencodeRunning: true }).state, 'working');
  assert.equal(approvalOf({ ...call, status: 'completed' }, log.asks()), 'asked');
  assert.equal(approvalOf({ ...call, id: 'call2', status: 'completed' }, log.asks()), 'rule');
  assert.equal(approvalOf({ ...call, status: 'error', error: 'The user declined this tool call' }, log.asks()), 'refused');

  // Answered while the call still runs (a long command): working again, not waiting.
  pending.check([], T + 80_000);
  assert.equal(state(T + 90_000).state, 'working');
});

test('how long a prompt waited: from when it was asked to when the monitor saw it answered', () => {
  const ask = { t: T, run: null, id: ASK_ID, kind: 'permission', permission: 'read', patterns: '.env', session: 's1', part: 'call1', answeredAt: T + 223_000 };
  // The call ran on for a long while after it was allowed; the wait ends at the answer.
  const tools = [{ id: 'call1', session_id: 's1', tool: 'bash', status: 'completed', time_created: T - 500, started: T - 100, ended: T + 900_000, time_updated: T + 900_000 }];
  const [prompt] = matchPrompts({ asks: [ask], replies: new Map([[ASK_ID, ask.answeredAt]]), tools, eventTimes: new Map(), now: T + 1_000_000 });
  assert.deepEqual([prompt.part.id, prompt.answeredAt, prompt.waitMs, prompt.abandoned], ['call1', T + 223_000, 223_000, false]);
  // A call over before the monitor looked again says more exactly when it was answered.
  const quick = [{ ...tools[0], ended: T + 221_500, time_updated: T + 221_500 }];
  assert.equal(matchPrompts({ asks: [ask], replies: new Map([[ASK_ID, ask.answeredAt]]), tools: quick, eventTimes: new Map(), now: T + 1_000_000 })[0].waitMs, 221_500);
});

test("OpenCode 2's questions are read from the calls themselves", () => {
  const tools = [
    { id: 'q1', v2: true, session_id: 's1', tool: 'question', status: 'completed', time_created: T, started: T + 100, ended: T + 188_000, time_updated: T + 188_000 },
    { id: 'q2', v2: true, session_id: 's1', tool: 'question', status: 'running', time_created: T + 200_000, started: T + 200_100, ended: null },
    { id: 'old', session_id: 's0', tool: 'question', status: 'completed', started: T - 9000, ended: T - 8000 }, // 1.x: the log has it
    { id: 'r', v2: true, session_id: 's1', tool: 'read', status: 'completed', started: T, ended: T + 5 },
  ];
  const { asks, replies } = questionsOf(tools);
  assert.deepEqual(asks.map(a => [a.id, a.kind, a.t]), [['q1', 'question', T + 100], ['q2', 'question', T + 200_100]]);
  assert.deepEqual([...replies], [['q1', T + 188_000]]);
  const log = { asks: () => [{ t: T - 9000, kind: 'question', id: 'que_log', permission: null, patterns: '', run: 'r' }], replies: () => new Map([['que_log', T - 8000]]) };
  const all = promptsFor(log, tools);
  const prompts = matchPrompts({ asks: all.asks, replies: all.replies, tools, eventTimes: new Map(), now: T + 300_000 });
  assert.deepEqual(prompts.map(p => [p.id, p.part?.id, p.answeredAt == null ? null : p.waitMs]), [['que_log', 'old', 1000], ['q1', 'q1', 187_900], ['q2', 'q2', null]]);
  // Nothing of OpenCode 2: the log's own lists, untouched.
  assert.deepEqual(promptsFor(log, tools.slice(2)).asks, log.asks());
});
