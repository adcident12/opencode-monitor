// OpenCode 2's message rows turned into 1.x rows, and both versions read from one database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { mcpCallsOf, normalizeV2, toolRowsOf } from '../src/db-v2.mjs';
import { openDb } from '../src/db.mjs';
import { turnsOfSession } from '../src/work.mjs';

const T = 1_791_690_000_000;
let seq = 0;
const row = (session, type, at, data, updated = at) => ({ id: `${type}${++seq}`, session_id: session, type, seq, time_created: at, time_updated: updated, data: JSON.stringify(data) });
const tool = (name, input, time, state = {}) => ({ type: 'tool', id: `${name}${time.created}`, name, state: { status: 'completed', input, content: [{ type: 'text', text: 'ok' }], ...state }, time });
const reply = (session, at, content, extra = {}) => row(session, 'assistant', at, {
  time: { created: at, streamed: at + 9000, completed: at + 10_000 },
  agent: 'build',
  model: { id: 'qwen', providerID: 'local' },
  content,
  finish: 'tool-calls',
  cost: 0,
  tokens: { input: 1000, output: 200, reasoning: 0, cache: { read: 5000, write: 0 } },
  ...extra,
}, at + 10_000);

test('an execute script counts as the MCP calls it made, named as 1.x named them', () => {
  const listed = { metadata: { toolCalls: [{ tool: 'search', status: 'completed' }, { tool: 'chrome-devtools.click', status: 'error', input: { uid: '1_2' } }, { tool: 'graft.graft_find_code', status: 'completed' }] } };
  assert.deepEqual(mcpCallsOf(listed), [
    { server: 'chrome-devtools', tool: 'click', status: 'error', input: { uid: '1_2' } },
    { server: 'graft', tool: 'graft_find_code', status: 'completed', input: null },
  ]);
  // Without OpenCode's own list nothing is claimed: the script's text is what it meant to
  // call, and one interrupted before its first call never ran the tool it names.
  const code = 'await new Promise(() => {}); const snap = await tools["chrome-devtools"].take_snapshot({ pageId: 2 });';
  assert.deepEqual(mcpCallsOf({ input: { code } }), []);

  const message = { id: 'm', session_id: 's', time_created: T, time_updated: T + 5000 };
  const calls = toolRowsOf(message, tool('execute', { code }, { created: T, ran: T + 1000, completed: T + 3000 }, listed));
  assert.deepEqual(calls.map(c => [c.tool, c.status, c.started, c.ended]), [
    ['chrome-devtools_click', 'error', T + 1000, T + 2000],
    ['graft_graft_find_code', 'completed', T + 2000, T + 3000],
  ]);
  assert.equal(new Set(calls.map(c => c.id)).size, 2);
  // Each call has its own input: two calls of one script are not one call made twice.
  assert.equal(calls[0].input, '{"uid":"1_2"}');
  assert.notEqual(calls[1].input, calls[0].input);
  const stopped = toolRowsOf(message, tool('execute', { code }, { created: T, ran: T + 100, completed: T + 900_000 }, { status: 'error', error: { type: 'aborted', message: 'Tool execution interrupted' } }));
  assert.deepEqual(stopped.map(c => [c.tool, c.status, c.error]), [['execute', 'error', 'Tool execution interrupted']]);
  // A script that only searched the tool catalog is one call of its own.
  const search = toolRowsOf(message, tool('execute', { code: 'search({ namespace: "graft" })' }, { created: T }, { metadata: { toolCalls: [{ tool: 'search', status: 'completed' }] } }));
  assert.deepEqual(search.map(c => c.tool), ['execute']);
});

test('a reply becomes a message, its timing, its spans, its tool calls and the files it changed', () => {
  const out = normalizeV2([
    row('s', 'user', T, { text: 'add a pause key' }),
    reply('s', T + 100, [
      { type: 'reasoning', text: '…', time: { created: T + 2000, completed: T + 6000 } },
      tool('shell', { command: 'ls' }, { created: T + 6500, ran: T + 9100, completed: T + 9500 }),
      tool('read', { path: 'src/a.js' }, { created: T + 7000, ran: T + 9200, completed: T + 9300 }),
      tool('subagent', { description: 'look around' }, { created: T + 7500, ran: T + 9300 }, { status: 'running', content: [] }),
    ], { snapshot: { files: ['/work/src/a.js'] } }),
  ]);
  assert.deepEqual(out.messages.map(m => m.role), ['user', 'assistant']);
  const m = out.messages[1];
  assert.deepEqual([m.finish, m.agent, m.provider_id, m.model_id, m.completed, m.tokens_input, m.tokens_cache_read, m.error_name],
    ['tool-calls', 'build', 'local', 'qwen', T + 10_100, 1000, 5000, null]);
  assert.deepEqual(out.steps, [{ message_id: m.id, first_token: T + 2000, written: T + 9100 }]);
  // No text: only thinking, its share by length of the time the reply took to write.
  assert.deepEqual(out.spans.map(s => [s.type, s.s]), [['reasoning', T + 2000]]);
  assert.ok(out.spans[0].e > T + 2000 && out.spans[0].e < T + 9100);
  // Renamed tools keep their 1.x names; `path` is the file.
  assert.deepEqual(out.tools.map(t => [t.tool, t.status, t.cmd, t.file, t.descr]), [
    ['bash', 'completed', 'ls', null, null],
    ['read', 'completed', null, 'src/a.js', null],
    ['task', 'running', null, null, 'look around'],
  ]);
  const running = out.tools[2];
  assert.deepEqual([running.ended, running.time_updated, running.message_id], [null, T + 10_100, m.id]);
  assert.deepEqual(out.patches.map(p => JSON.parse(p.files)), [['/work/src/a.js']]);
  // The live view's rows: where the request began, each call, the files, and its token count.
  assert.deepEqual(out.parts.map(p => p.type), ['step-start', 'tool', 'tool', 'tool', 'patch', 'step-finish']);
  const finish = out.parts.at(-1);
  assert.deepEqual([finish.tokens_input, finish.tokens_cache_read, finish.tokens_total], [1000, 5000, 6200]);
});

test('a compaction is a compaction and a reply of the compaction agent; an interrupted turn is an aborted reply', () => {
  const out = normalizeV2([
    row('s', 'user', T, { text: 'go' }),
    reply('s', T + 100, []),
    row('s', 'compaction', T + 20_000, { status: 'completed', reason: 'auto', summary: '…', model: { id: 'qwen', providerID: 'local' }, cost: 0, tokens: { input: 34_249, output: 1425, reasoning: 0, cache: { read: 0, write: 0 } } }, T + 80_000),
    row('s', 'synthetic', T + 80_100, { text: 'Continue if you have next steps' }),
    reply('s', T + 80_200, [], { finish: null, tokens: undefined, time: { created: T + 80_200 } }),
    row('s', 'idle', T + 90_000, { outcome: 'interrupted' }),
    row('s', 'system', T + 90_001, { text: 'instructions changed' }),
    { id: 'broken', session_id: 's', type: 'assistant', time_created: T + 95_000, time_updated: T + 95_000, data: '{not json' },
  ]);
  assert.deepEqual(out.compactions, [{ session_id: 's', time_created: T + 20_000, auto: 1, overflow: 0 }]);
  const summary = out.messages.find(m => m.agent === 'compaction');
  assert.deepEqual([summary.role, summary.summary, summary.completed, summary.compacting], ['assistant', true, T + 80_000, false]);
  // What the summary cost is on its row: counted as a request of that model, as 1.x counted it.
  assert.deepEqual([summary.model_id, summary.tokens_input, summary.tokens_output], ['qwen', 34_249, 1425]);
  // A prompt of yours that OpenCode 2 compacts before answering is still a turn of yours.
  const squeezed = normalizeV2([
    row('s', 'user', T, { text: 'go on' }),
    row('s', 'compaction', T + 100, { status: 'completed', reason: 'auto' }, T + 60_000),
    reply('s', T + 60_100, [], { finish: 'stop' }),
  ]).messages;
  assert.deepEqual(turnsOfSession(squeezed).map(t => [t.at, t.replies.length]), [[T, 1]]);
  // Not done yet: no end, no cost, and the session is compacting.
  const running = normalizeV2([row('s', 'compaction', T, { status: 'running', reason: 'auto', summary: '' })]).messages[0];
  assert.deepEqual([running.compacting, running.completed, running.finish, running.model_id, running.tokens_input], [true, null, null, null, null]);
  assert.equal(out.messages.filter(m => m.synthetic).length, 1);
  assert.equal(out.messages.at(-1).error_name, 'MessageAbortedError');
  // A reply still being written has no token count yet: nothing is said about the context.
  assert.deepEqual(out.parts.map(p => p.type), ['step-start', 'step-finish', 'compaction', 'step-start']);
});

test('what OpenCode 2 does not time is worked out from what it does, or left unknown', () => {
  const thought = { type: 'reasoning', text: 'x'.repeat(300), time: { created: T + 2000, completed: T + 9000 } };
  const out = normalizeV2([
    // OpenCode 2 times the reasoning to the end of the reply: shared out by length, 300 to 100.
    reply('s', T, [thought, { type: 'text', text: 'y'.repeat(100) }], { finish: 'stop' }),
    // A reply that opens with text: no first token is known, and no thinking or writing time.
    reply('s', T + 20_000, [{ type: 'text', text: 'ok' }, tool('read', { path: 'a' }, { created: T + 25_000, ran: T + 29_100, completed: T + 29_200 })]),
    // A row copied from 1.x: the reasoning has its own end, a call's "created" is when it started.
    reply('s', T + 40_000, [{ ...thought, time: { created: T + 41_000, completed: T + 43_000 } }, { type: 'text', text: 'so' }, tool('bash', { command: 'ls' }, { created: T + 45_000, completed: T + 47_000 })], { time: { created: T + 40_000, completed: T + 48_000 } }),
    // A compaction whose row was touched long after: over when the next row was written.
    row('s', 'compaction', T + 60_000, { status: 'completed', reason: 'manual' }, T + 9_000_000),
    row('s', 'user', T + 75_000, { text: 'next' }),
  ]);
  assert.deepEqual(out.spans.map(s => [s.type, s.s - T, s.e - T]), [
    ['reasoning', 2000, 7250], ['text', 7250, 9000],
    ['reasoning', 41_000, 43_000], ['text', 43_000, 45_000],
  ]);
  assert.deepEqual(out.steps.map(s => [s.first_token, s.written]), [[T + 2000, T + 9000], [null, T + 29_000], [T + 41_000, T + 45_000]]);
  assert.deepEqual(out.tools.map(t => [t.started, t.ended]), [[T + 29_100, T + 29_200], [T + 45_000, T + 47_000]]);
  const summary = out.messages.find(m => m.agent === 'compaction');
  assert.deepEqual([summary.completed, out.compactions[0].auto], [T + 75_000, 0]);
});

test('a database made by OpenCode 2 alone, with none of the 1.x tables, is read all the same', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ocm-v2only-'));
  const raw = new DatabaseSync(join(dir, 'opencode.db'));
  raw.exec(`create table session_v2 (id text primary key, parent_id text, directory text, title text, version text, model text, time_created integer, time_updated integer, time_compacting integer);
    create table session_message (id text primary key, session_id text, type text, seq integer, time_created integer, time_updated integer, data text);`);
  raw.prepare('insert into session_v2 values (?,?,?,?,?,?,?,?,?)').run('new', null, '/work/y', 'New', '2.0.26', null, T, T + 20_000, null);
  const put = r => raw.prepare('insert into session_message values (?,?,?,?,?,?,?)').run(r.id, r.session_id, r.type, r.seq, r.time_created, r.time_updated, r.data);
  put(row('new', 'user', T, { text: 'hello' }));
  put(reply('new', T + 100, [tool('shell', { command: 'ls' }, { created: T + 500, ran: T + 9200, completed: T + 9900 })], { finish: 'stop' }));
  raw.close();

  const db = openDb(dir);
  try {
    assert.equal(db.v2, true);
    assert.deepEqual(db.recentSessions(0, 5).map(s => [s.id, s.version]), [['new', '2.0.26']]);
    assert.deepEqual(db.stats.tools(0).map(t => [t.tool, t.cmd]), [['bash', 'ls']]);
    assert.deepEqual(db.stats.messages(0).map(m => m.role), ['user', 'assistant']);
    assert.deepEqual(db.parts('new').map(p => p.type), ['step-start', 'tool', 'step-finish']);
    assert.deepEqual(db.lastMessages('new').map(m => [m.role, m.finish ?? null]), [['user', null], ['assistant', 'stop']]);
    assert.deepEqual([db.todos('new'), db.stats.todoStatus(), db.stats.toolEvents('new'), db.replay.tree('new').length], [[], [], [], 1]);
  } finally {
    db.close();
  }
  // Nothing was written: the file still has no 1.x table.
  const after = new DatabaseSync(join(dir, 'opencode.db'), { readOnly: true });
  assert.deepEqual(after.prepare("select name from sqlite_master where type = 'table' order by name").all().map(r => r.name), ['session_message', 'session_v2']);
  after.close();
  rmSync(dir, { recursive: true, force: true });

  // A database with neither layout is still refused, saying what is missing.
  const bad = mkdtempSync(join(tmpdir(), 'ocm-none-'));
  const half = new DatabaseSync(join(bad, 'opencode.db'));
  half.exec('create table session_v2 (id text primary key)');
  half.close();
  assert.throws(() => openDb(bad), /table "session" is missing/);
  rmSync(bad, { recursive: true, force: true });
});

test('one database with both versions: nothing OpenCode 2 copied from 1.x is counted twice', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ocm-v2-'));
  const raw = new DatabaseSync(join(dir, 'opencode.db'));
  raw.exec(`create table session (id text primary key, parent_id text, directory text, title text, time_created integer, time_updated integer);
    create table message (id text primary key, session_id text, time_created integer, data text);
    create table part (id text primary key, message_id text, session_id text, time_created integer, time_updated integer, data text);
    create index message_session_time on message (session_id, time_created, id);
    create table session_v2 (id text primary key, parent_id text, directory text, title text, version text, model text, time_created integer, time_updated integer, time_compacting integer);
    create table session_message (id text primary key, session_id text, type text, seq integer, time_created integer, time_updated integer, data text);`);
  const session = raw.prepare('insert into session values (?,?,?,?,?,?)');
  const sessionV2 = raw.prepare('insert into session_v2 values (?,?,?,?,?,?,?,?,?)');
  const message = raw.prepare('insert into message values (?,?,?,?)');
  const part = raw.prepare('insert into part values (?,?,?,?,?,?)');
  const messageV2 = raw.prepare('insert into session_message values (?,?,?,?,?,?,?)');
  const put = r => messageV2.run(r.id, r.session_id, r.type, r.seq, r.time_created, r.time_updated, r.data);

  // "old": written by 1.x, copied by OpenCode 2, then carried on in it.
  session.run('old', null, '/work/x', 'Old', T, T + 20_000);
  sessionV2.run('old', null, '/work/x', 'Old', '2.0.26', null, T, T + 200_000, null);
  message.run('u1', 'old', T, JSON.stringify({ role: 'user' }));
  message.run('a1', 'old', T + 100, JSON.stringify({ role: 'assistant', finish: 'stop', agent: 'build', providerID: 'local', modelID: 'qwen', time: { completed: T + 10_000 }, tokens: { input: 10, output: 5, cache: { read: 0, write: 0 } } }));
  part.run('p1', 'a1', 'old', T + 5000, T + 6000, JSON.stringify({ type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: 'ls' }, time: { start: T + 5000, end: T + 6000 } } }));
  put({ ...row('old', 'user', T, { text: 'copied' }), id: 'u1' });
  put({ ...reply('old', T + 100, [tool('bash', { command: 'ls' }, { created: T + 5000, ran: T + 5000, completed: T + 6000 })]), id: 'a1' });
  put(row('old', 'user', T + 100_000, { text: 'and now this' }));
  put(reply('old', T + 100_100, [tool('shell', { command: 'pwd' }, { created: T + 100_500, ran: T + 109_200, completed: T + 109_900 })], { finish: 'stop' }));
  // "new": begun in OpenCode 2, with a subagent.
  sessionV2.run('new', null, '/work/y', 'New', '2.0.26', '{"id":"qwen","providerID":"local"}', T + 300_000, T + 320_000, null);
  sessionV2.run('new-sub', 'new', '/work/y', 'Sub', '2.0.26', null, T + 301_000, T + 310_000, null);
  put(row('new', 'user', T + 300_000, { text: 'hello' }));
  put(reply('new', T + 300_100, [tool('execute', { code: 'await tools.graft.graft_find_code({})' }, { created: T + 300_500, ran: T + 309_200, completed: T + 309_900 }, { metadata: { toolCalls: [{ tool: 'graft.graft_find_code', status: 'completed', input: {} }] } })]));
  put(reply('new-sub', T + 301_000, [], { agent: 'general', finish: 'stop' }));
  raw.close();

  const db = openDb(dir);
  try {
    assert.equal(db.v2, true);
    assert.deepEqual(db.stats.sessions(0).map(s => [s.id, s.time_updated]).sort(), [['new', T + 320_000], ['new-sub', T + 310_000], ['old', T + 200_000]]);
    assert.deepEqual(db.stats.tools(0).map(t => `${t.session_id}:${t.tool}:${t.cmd ?? ''}`).sort(), ['new:graft_graft_find_code:', 'old:bash:ls', 'old:bash:pwd']);
    assert.deepEqual(db.stats.messages(0).map(m => `${m.session_id}:${m.role}`).sort(), ['new-sub:assistant', 'new:assistant', 'new:user', 'old:assistant', 'old:assistant', 'old:user', 'old:user']);
    assert.deepEqual(db.stats.models(0), [{ provider: 'local', model: 'qwen', requests: 4, last: T + 301_000 }]);
    assert.equal(db.stats.steps(0).length, 4);

    assert.deepEqual(db.recentSessions(0, 2).map(s => [s.id, s.version]), [['new', '2.0.26'], ['new-sub', '2.0.26']]);
    assert.deepEqual(db.replay.tree('new').map(s => s.id).sort(), ['new', 'new-sub']);
    assert.deepEqual(db.replay.tools(['new', 'new-sub']).map(t => t.tool), ['graft_graft_find_code']);

    // The live view of the session carried on: its 1.x part and what OpenCode 2 added.
    const parts = db.parts('old');
    assert.deepEqual(parts.map(p => p.type), ['tool', 'step-start', 'tool', 'step-finish']);
    assert.deepEqual(db.partStats('old'), { count: 4, max_updated: T + 110_100 });
    assert.deepEqual(db.parts('old', T + 110_000).map(p => p.type), ['step-start', 'step-finish']);
    // The monitor trims the rows it is given: the next read is whole again.
    delete parts[2].cmd;
    assert.equal(db.parts('old')[2].cmd, 'pwd');
    assert.deepEqual(db.lastMessages('old').map(m => [m.role, m.finish ?? null]), [['user', null], ['assistant', 'stop'], ['user', null], ['assistant', 'stop']]);
    assert.deepEqual(db.partStats('new-sub'), { count: 2, max_updated: T + 311_000 });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
