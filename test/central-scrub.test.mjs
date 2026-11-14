// OpenCode Central: the content contract. Rows leave a machine through scrubRow only; nothing a person wrote, a
// model replied, a tool printed, or a path named may survive it. Numbers, times, statuses and names do.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrubRow, FILLER, MAX_FILL } from '../src/central/scrub.mjs';

const ctx = { hmacKey: Buffer.alloc(32, 7), machine: 'poppy' };
const S = 'SECRET-xyz';
const data = row => JSON.parse(row.data);

// ── OpenCode 1.x rows ──
const session = { id: 'ses_1', parent_id: null, directory: `C:\\Users\\${S}\\work\\shop-api`, title: 'fix the cart', time_created: 1, time_updated: 2, version: '1.18.35', share_url: `https://x/${S}` };
const message = { id: 'msg_1', session_id: 'ses_1', time_created: 1, time_updated: 2, data: JSON.stringify({
  role: 'assistant', modelID: 'qwen3.6', providerID: 'llama', cost: 0.01, finish: 'stop', agent: 'build',
  tokens: { input: 900, output: 120, reasoning: 30, cache: { read: 700, write: 10 } }, time: { created: 1, completed: 5 },
  error: { name: 'APIError', data: { message: S } }, summary: { title: S, body: S }, path: { cwd: `C:\\${S}` }, system: [S] }) };
const tool = (input, extra = {}) => ({ id: 'prt_1', message_id: 'msg_1', session_id: 'ses_1', time_created: 1, time_updated: 9, data: JSON.stringify({
  type: 'tool', tool: 'bash', callID: 'c1', state: { status: 'completed', input, output: `${S} out`, title: S,
    metadata: { output: `${S}`.repeat(10), description: S }, error: `${S} failed`, time: { start: 3, end: 8 } }, ...extra }) });
const textPart = len => ({ id: 'prt_t', message_id: 'msg_1', session_id: 'ses_1', time_created: 1, time_updated: 2, data: JSON.stringify({ type: 'text', text: 'S'.repeat(len), time: { start: 1, end: 2 } }) });
const patch = files => ({ id: 'prt_p', message_id: 'msg_1', session_id: 'ses_1', time_created: 1, time_updated: 2, data: JSON.stringify({ type: 'patch', hash: 'abc', files }) });
const stepFinish = { id: 'prt_f', message_id: 'msg_1', session_id: 'ses_1', time_created: 1, time_updated: 2, data: JSON.stringify({
  type: 'step-finish', reason: 'tool-calls', cost: 0.002, tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 3, write: 0 } }, snapshot: S }) };
const compaction = { id: 'prt_c', message_id: 'msg_1', session_id: 'ses_1', time_created: 1, time_updated: 2, data: JSON.stringify({ type: 'compaction', auto: true, overflow: false }) };
const todo = { session_id: 'ses_1', content: `${S} write tests`, status: 'pending', priority: 'high', position: 0 };

// ── OpenCode 2 rows ──
const v2session = { id: 'ses_2', parent_id: null, directory: `/home/${S}/proj/web`, title: 'web title', time_created: 1, time_updated: 2, version: '2.0.29', model: 'llama/qwen' };
const v2assistant = { id: 'm2', session_id: 'ses_2', type: 'assistant', seq: 3, time_created: 1, time_updated: 9, data: JSON.stringify({
  finish: 'stop', agent: 'build', cost: 0, model: { providerID: 'llama', id: 'qwen' },
  tokens: { input: 5000, output: 400, reasoning: 100, cache: { read: 4000, write: 0 } },
  time: { created: 1, completed: 9, streamed: 2 }, error: { type: 'api', name: 'APIError', message: S },
  snapshot: { files: [`C:/${S}/a.ts`, 'C:/b.ts'] },
  content: [
    { type: 'reasoning', text: `${S} thinking`, time: { created: 2, completed: 3 } },
    { type: 'text', text: `${S} answer` },
    { type: 'tool', id: 'call_1', name: 'shell', time: { created: 3, ran: 4, completed: 6 },
      state: { status: 'completed', input: { command: `cat ${S}`, background: false }, content: [{ type: 'text', text: S }],
        metadata: { output: S, exit: 0 }, error: { message: S } } },
    { type: 'tool', id: 'call_2', name: 'execute', time: { created: 6, completed: 7 },
      state: { status: 'completed', input: { code: S }, metadata: { toolCalls: [{ tool: 'github.search', status: 'completed', input: { q: S } }] } } },
    { type: 'tool', id: 'call_3', name: 'todowrite', time: { created: 7, completed: 8 },
      state: { status: 'completed', input: { todos: [{ content: S, status: 'completed' }, { content: S, status: 'pending' }] } } },
    { type: 'tool', id: 'call_4', name: 'read', time: { created: 8, completed: 8 },
      state: { status: 'completed', input: { filePath: `/${S}.ts`, offset: 10, limit: 50 } } },
  ] }) };
const v2user = { id: 'm1', session_id: 'ses_2', type: 'user', seq: 1, time_created: 1, time_updated: 1, data: JSON.stringify({ text: S, files: [S] }) };
const v2compaction = { id: 'm3', session_id: 'ses_2', type: 'compaction', seq: 4, time_created: 1, time_updated: 2, data: JSON.stringify({
  reason: 'auto', status: 'completed', summary: S, model: { providerID: 'llama', id: 'qwen' }, tokens: { input: 1, output: 2 }, cost: 0 }) };
const v2idle = { id: 'm4', session_id: 'ses_2', type: 'idle', seq: 5, time_created: 1, time_updated: 2, data: JSON.stringify({ outcome: 'interrupted', note: S }) };

const ALL = [
  ['session', session], ['message', message], ['part', tool({ command: `rm -rf ${S}`, description: S, filePath: `/${S}` })],
  ['part', textPart(40)], ['part', patch([`/${S}/x.ts`])], ['part', stepFinish], ['part', compaction], ['todo', todo],
  ['session_v2', v2session], ['session_message', v2assistant], ['session_message', v2user],
  ['session_message', v2compaction], ['session_message', v2idle],
];

test('no content survives: every SECRET in every row of both versions is gone', () => {
  for (const [table, row] of ALL) assert.doesNotMatch(JSON.stringify(scrubRow(table, row, ctx)), /SECRET/, `${table} ${row.id ?? ''}`);
});

test('lengths kept: text becomes filler of the same length, capped', () => {
  assert.equal(data(scrubRow('part', textPart(1234), ctx)).text, FILLER.repeat(1234));
  assert.equal(data(scrubRow('part', textPart(MAX_FILL + 10), ctx)).text.length, MAX_FILL);
  const out = data(scrubRow('part', tool({ command: 'ls' }), ctx)).state;
  assert.equal(out.metadata.output, FILLER.repeat(`${S}`.repeat(10).length));
});

test('tool inputs: equal stay equal, different differ, the JSON length is kept', () => {
  const a = data(scrubRow('part', tool({ command: 'npm test' }), ctx)).state.input;
  const b = data(scrubRow('part', tool({ command: 'npm test' }), ctx)).state.input;
  const c = data(scrubRow('part', tool({ command: 'npm run build' }), ctx)).state.input;
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
  assert.equal(JSON.stringify(c).length, JSON.stringify({ command: 'npm run build' }).length);
  assert.equal(JSON.stringify(scrubRow('part', tool({ command: 'npm test' }), { ...ctx, hmacKey: Buffer.alloc(32, 8) })).includes(JSON.stringify(a)), false, 'keyed: another machine hashes differently');
});

test('tool inputs keep only what is not content: offset, limit, background, todo statuses', () => {
  const items = data(scrubRow('session_message', v2assistant, ctx)).content;
  const byName = n => items.find(i => i.name === n).state.input;
  assert.equal(byName('read').offset, 10);
  assert.equal(byName('read').limit, 50);
  assert.equal(byName('shell').background, false);
  assert.deepEqual(byName('todowrite').todos, [{ status: 'completed' }, { status: 'pending' }]);
  assert.equal(items.find(i => i.name === 'execute').state.metadata.toolCalls[0].tool, 'github.search');
});

test('paths hashed: patch files, snapshot files; directory becomes /machine/folder', () => {
  assert.match(data(scrubRow('part', patch(['C:/a/b.ts', 'C:/c.ts']), ctx)).files[0], /^f:[0-9a-f]{16}$/);
  assert.equal(data(scrubRow('part', patch(['C:/a/b.ts', 'C:/c.ts']), ctx)).files.length, 2);
  assert.match(data(scrubRow('session_message', v2assistant, ctx)).snapshot.files[1], /^f:[0-9a-f]{16}$/);
  assert.equal(scrubRow('session', session, ctx).directory, '/poppy/shop-api');
  assert.equal(scrubRow('session_v2', v2session, ctx).directory, '/poppy/web');
});

test('kept as is: tokens, cost, times, status, tool, model, title, version, error name', () => {
  const m = data(scrubRow('message', message, ctx));
  assert.deepEqual(m.tokens, { input: 900, output: 120, reasoning: 30, cache: { read: 700, write: 10 } });
  assert.deepEqual([m.role, m.modelID, m.providerID, m.cost, m.finish, m.agent, m.error.name], ['assistant', 'qwen3.6', 'llama', 0.01, 'stop', 'build', 'APIError']);
  assert.equal(m.summary, true, 'a summary is only marked as there');
  const t = data(scrubRow('part', tool({ command: 'x' }), ctx));
  assert.deepEqual([t.type, t.tool, t.state.status, t.state.time.start, t.state.time.end], ['tool', 'bash', 'completed', 3, 8]);
  const s = scrubRow('session_v2', v2session, ctx);
  assert.deepEqual([s.title, s.version, s.model, s.time_updated], ['web title', '2.0.29', 'llama/qwen', 2]);
  const a = data(scrubRow('session_message', v2assistant, ctx));
  assert.deepEqual([a.time.streamed, a.model.id, a.tokens.cache.read, a.error.name, a.error.type], [2, 'qwen', 4000, 'APIError', 'api']);
  assert.equal(data(scrubRow('session_message', v2idle, ctx)).outcome, 'interrupted');
  assert.equal(data(scrubRow('session_message', v2compaction, ctx)).reason, 'auto');
});

test('unknown keys and columns are dropped: a future text field cannot leak', () => {
  const p = tool({ command: 'x' });
  const d = data(p);
  d.state.summaryText = S;
  d.newThing = { note: S };
  const out = data(scrubRow('part', { ...p, data: JSON.stringify(d) }, ctx));
  assert.equal('summaryText' in out.state, false);
  assert.equal('newThing' in out, false);
  assert.equal('share_url' in scrubRow('session', session, ctx), false);
});

test('todo rows: content becomes filler, status and position kept', () => {
  const t = scrubRow('todo', todo, ctx);
  assert.equal(t.content, FILLER.repeat(todo.content.length));
  assert.deepEqual([t.status, t.position, t.session_id], ['pending', 0, 'ses_1']);
});

test('a row whose data is not JSON keeps its columns and gets empty data', () => {
  assert.equal(scrubRow('part', { ...tool({}), data: '{not json' }, ctx).data, '{}');
});
