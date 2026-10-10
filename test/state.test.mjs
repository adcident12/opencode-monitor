import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveState, deriveHealth, bubbleChildren } from '../src/state.mjs';
import { DEFAULTS } from '../src/config.mjs';

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const thresholds = DEFAULTS.thresholds;
const session = { id: 's1', time_created: NOW - 60 * MIN, time_compacting: null };

const user = ago => ({ id: `u${ago}`, role: 'user', time_created: NOW - ago });
const assistant = (ago, extra = {}) => ({ id: `a${ago}`, role: 'assistant', time_created: NOW - ago, error: null, finish: null, completed: null, ...extra });
const tool = (message, name, status, ago, extra = {}) => ({
  id: `p${ago}${name}`, message_id: message.id, type: 'tool', tool: name, status,
  time_created: NOW - ago, time_updated: NOW - ago, started: NOW - ago, ...extra,
});
const derive = (messages, parts = [], extra = {}) =>
  deriveState({ session, parts, messages, asks: [], now: NOW, thresholds, opencodeRunning: true, ...extra });

test('empty session is idle', () => {
  assert.equal(derive([]).reason, 'empty');
});

test('a running tool under the threshold is working', () => {
  const a = assistant(2 * MIN);
  const r = derive([user(3 * MIN), a], [tool(a, 'bash', 'running', MIN, { cmd: 'npm test' })]);
  assert.deepEqual([r.state, r.reason, r.since], ['working', 'tool', NOW - 3 * MIN]);
});

test('a tool running past the threshold is stuck', () => {
  const a = assistant(40 * MIN);
  const r = derive([user(41 * MIN), a], [tool(a, 'bash', 'running', 35 * MIN)]);
  assert.deepEqual([r.state, r.reason, r.since], ['stuck', 'tool_long', NOW - 35 * MIN]);
});

test('per-tool thresholds override the default', () => {
  const a = assistant(40 * MIN);
  assert.equal(derive([user(41 * MIN), a], [tool(a, 'task', 'running', 35 * MIN)]).state, 'working');
});

test('a running question tool means waiting', () => {
  const a = assistant(40 * MIN);
  const r = derive([user(41 * MIN), a], [tool(a, 'question', 'running', 35 * MIN, { question: 'Which one?' })]);
  assert.deepEqual([r.state, r.reason, r.prompt.detail], ['waiting', 'question', 'Which one?']);
});

test('a permission prompt logged at the part\'s last update means waiting, however long ago', () => {
  const a = assistant(500 * MIN);
  const part = tool(a, 'read', 'running', 490 * MIN);
  const asks = [{ t: NOW - 490 * MIN + 2, kind: 'permission', permission: 'read', patterns: '.env' }];
  const r = derive([user(501 * MIN), a], [part], { asks });
  assert.deepEqual([r.state, r.reason, r.prompt.permission, r.since], ['waiting', 'permission', 'read', asks[0].t]);
});

test('once the part is updated after the prompt, it was answered', () => {
  const a = assistant(5 * MIN);
  const part = tool(a, 'bash', 'running', 4 * MIN, { time_updated: NOW - MIN });
  const asks = [{ t: NOW - 4 * MIN, kind: 'permission', permission: 'bash', patterns: 'x' }];
  assert.equal(derive([user(6 * MIN), a], [part], { asks }).state, 'working');
});

test('finished, length, and message errors', () => {
  const done = assistant(5 * MIN, { finish: 'stop', completed: NOW - 4 * MIN });
  assert.deepEqual([derive([user(6 * MIN), done]).state, derive([user(6 * MIN), done]).since], ['finished', NOW - 4 * MIN]);
  assert.equal(derive([assistant(5 * MIN, { finish: 'length', completed: NOW - 4 * MIN })]).reason, 'length');
  assert.equal(derive([assistant(5 * MIN, { error: 'APIError' })]).state, 'error');
  assert.equal(derive([assistant(5 * MIN, { error: 'MessageAbortedError' })]).reason, 'aborted');
});

test('model silence: working, then stuck past the threshold', () => {
  assert.equal(derive([user(2 * MIN)]).reason, 'thinking');
  assert.equal(derive([user(2 * MIN), assistant(MIN)]).reason, 'generating');
  const step = assistant(3 * MIN, { finish: 'tool-calls', completed: NOW - MIN });
  assert.equal(derive([user(4 * MIN), step]).reason, 'between_steps');
  assert.deepEqual([derive([user(30 * MIN)]).state, derive([user(30 * MIN)]).reason], ['stuck', 'silent']);
});

test('running tools on older messages are ignored as leftovers', () => {
  const old = assistant(900 * MIN);
  const done = assistant(5 * MIN, { finish: 'stop', completed: NOW - 4 * MIN });
  assert.equal(derive([old, user(6 * MIN), done], [tool(old, 'write', 'running', 899 * MIN)]).state, 'finished');
});

test('nothing is live when OpenCode is not running', () => {
  const a = assistant(40 * MIN);
  const parts = [tool(a, 'bash', 'running', 35 * MIN)];
  assert.equal(derive([user(41 * MIN), a], parts, { opencodeRunning: false }).reason, 'not_running');
  assert.equal(derive([user(41 * MIN), a], parts, { opencodeRunning: null }).state, 'stuck');
  const done = assistant(5 * MIN, { finish: 'stop', completed: NOW - 4 * MIN });
  assert.equal(derive([done], [], { opencodeRunning: false }).state, 'finished');
});

test('compacting counts as working', () => {
  const r = deriveState({ session: { ...session, time_compacting: NOW - MIN }, parts: [], messages: [user(30 * MIN)], asks: [], now: NOW, thresholds, opencodeRunning: true });
  assert.equal(r.reason, 'compacting');
});

test('health: context, compactions, errors, repeats, hints', () => {
  const m = { id: 'm' };
  const parts = [
    ...Array.from({ length: 4 }, (_, i) => ({ type: 'compaction', time_updated: i })),
    ...Array.from({ length: 3 }, (_, i) => tool(m, 'bash', i ? 'error' : 'completed', i + 1, { input: '{"command":"npm test"}', input_len: 22, cmd: 'npm test', error: 'boom' })),
    tool(m, 'read', 'completed', 9, { input: '{"filePath":"a"}', input_len: 16, file: 'a' }),
    { type: 'step-finish', tokens_input: 2000, tokens_cache_read: 118_000, tokens_cache_write: 0 },
  ];
  const h = deriveHealth({ session: { time_created: NOW - 7 * 60 * MIN }, parts, now: NOW, thresholds, contextLimit: 131_072 });
  assert.equal(h.contextTokens, 120_000);
  assert.equal(h.contextPct, 92);
  assert.deepEqual([h.compactions, h.toolCalls, h.toolErrors], [4, 4, 2]);
  assert.deepEqual([h.repeat.count, h.repeat.text], [3, 'npm test']);
  assert.deepEqual(h.hints, ['context_high', 'many_compactions', 'old_session', 'looping']);
  assert.equal(h.suggestNewSession, true);
});

test('health without a known limit reports tokens but no percentage', () => {
  const h = deriveHealth({ session: { time_created: NOW }, parts: [{ type: 'step-finish', tokens_input: 10, tokens_cache_read: 5 }], now: NOW, thresholds, contextLimit: null });
  assert.deepEqual([h.contextTokens, h.contextPct, h.hints.length], [15, null, 0]);
});

test('a subagent prompt surfaces on its parent', () => {
  const prompt = { kind: 'permission', permission: 'bash', detail: 'npm outdated' };
  const list = bubbleChildren([
    { id: 'p', parentId: null, state: 'working', reason: 'tool', current: { tool: 'task' }, since: 1 },
    { id: 'c', parentId: 'p', state: 'waiting', reason: 'permission', since: 5, prompt },
  ]);
  assert.deepEqual([list[0].state, list[0].reason, list[0].since, list[0].viaChild, list[0].prompt], ['waiting', 'child_waiting', 5, 'c', prompt]);
});

test('a long task with a working subagent is not stuck', () => {
  const list = bubbleChildren([
    { id: 'p', parentId: null, state: 'stuck', reason: 'tool_long', current: { tool: 'task' } },
    { id: 'c', parentId: 'p', state: 'working' },
  ]);
  assert.deepEqual([list[0].state, list[0].reason], ['working', 'subagent']);
});

test('health: room before OpenCode compacts, and roughly how many requests that is', async () => {
  const { compactionPoint } = await import('../src/opencode-config.mjs');
  // 131 072 window, 32 768 output configured: OpenCode reserves at most 32 000.
  const at = compactionPoint(131_072, { output: 32_768, input: null });
  assert.equal(at, 99_072);
  assert.equal(compactionPoint(131_072, { output: 8192, input: null }), 122_880);
  assert.equal(compactionPoint(200_000, { output: null, input: 150_000 }), 150_000);
  assert.equal(compactionPoint(null, null), null);

  const step = (sent, out = 500) => ({ type: 'step-finish', tokens_input: 1000, tokens_cache_read: sent - 1000, tokens_cache_write: 0, tokens_output: out });
  const health = parts => deriveHealth({ session: { time_created: NOW - MIN }, parts, now: NOW, thresholds, contextLimit: 131_072, compactAt: at });

  // Before the compaction: 60k, irrelevant. After it, growth of about 6k per request.
  const calm = health([step(60_000), { type: 'compaction' }, step(30_000), step(36_000), step(42_000), step(48_000)]);
  assert.deepEqual(calm.health ?? calm.compaction, { at, room: at - 48_500, growth: 6000, requestsLeft: 8 });
  assert.ok(!calm.hints.includes('context_high'));

  // Three requests left: warned, though the window itself is only 69% full.
  const close = health([step(70_000), step(76_000), step(82_000), step(88_000)]);
  assert.equal(close.compaction.requestsLeft, 1);
  assert.ok(close.hints.includes('context_high'));
  assert.equal(close.contextPct, 67);

  // Too few requests to tell a pace: the room is still known.
  const fresh = health([step(30_000)]);
  assert.deepEqual([fresh.compaction.room, fresh.compaction.growth, fresh.compaction.requestsLeft], [at - 30_500, null, null]);
  // Without a compaction point the old rule applies, against the window.
  assert.equal(deriveHealth({ session: { time_created: NOW }, parts: [step(120_000)], now: NOW, thresholds, contextLimit: 131_072 }).compaction, null);
});
