import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { buildTools, createMcpServer, serve } from '../src/mcp-server.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const echo = { name: 'echo', description: 'Says it back.', inputSchema: { type: 'object', properties: {} }, run: args => ({ said: args }) };
const broken = { name: 'broken', description: 'Fails.', inputSchema: { type: 'object', properties: {} }, run: () => { throw new Error('database is locked'); } };
const handle = createMcpServer({ tools: [echo, broken], version: '1.2.3' });
const ask = (method, params, id = 1) => handle({ jsonrpc: '2.0', id, method, params });

test('initialize: our name, the tools capability, and the client\'s protocol version when we speak it', () => {
  const { result } = ask('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'x', version: '1' } });
  assert.equal(result.protocolVersion, '2025-03-26');
  assert.deepEqual(result.serverInfo, { name: 'opencode-monitor', version: '1.2.3' });
  assert.deepEqual(result.capabilities, { tools: {} });
  assert.match(result.instructions, /read-only/);
  // A version we do not know: offer our newest and let the client decide.
  assert.equal(ask('initialize', { protocolVersion: '2099-01-01' }).result.protocolVersion, '2025-06-18');
});

test('every tool is declared read-only', () => {
  const { tools } = ask('tools/list').result;
  assert.deepEqual(tools.map(t => t.name), ['echo', 'broken']);
  for (const tool of tools) {
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.annotations.destructiveHint, false);
    assert.equal(tool.inputSchema.type, 'object');
  }
});

test('a call answers with JSON as text; a tool that fails is an answer, not a protocol error', () => {
  const ok = ask('tools/call', { name: 'echo', arguments: { days: 7 } }).result;
  assert.deepEqual(JSON.parse(ok.content[0].text), { said: { days: 7 } });
  assert.equal(ok.isError, undefined);
  // Arguments that are not an object are treated as none.
  assert.deepEqual(JSON.parse(ask('tools/call', { name: 'echo', arguments: 'x' }).result.content[0].text), { said: {} });
  const bad = ask('tools/call', { name: 'broken' }).result;
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /database is locked/);
});

test('what is not understood is refused by the rules of JSON-RPC', () => {
  assert.equal(ask('tools/call', { name: 'nope' }).error.code, -32602);
  assert.equal(ask('resources/list').error.code, -32601);
  assert.equal(ask('constructor').error.code, -32601);
  assert.equal(handle({ id: 1, method: 'ping' }).error.code, -32600);
  assert.equal(handle([]).error.code, -32600);
  assert.deepEqual(ask('ping', undefined, 'abc'), { jsonrpc: '2.0', id: 'abc', result: {} });
  // Notifications and stray replies get no answer.
  assert.equal(handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.equal(handle({ jsonrpc: '2.0', method: 'notifications/unknown' }), null);
  assert.equal(handle({ jsonrpc: '2.0', id: 4, result: {} }), null);
});

test('one message per line, split across chunks; a broken line does not stop the next', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  serve(handle, input, output);
  const line = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' });
  input.write(line.slice(0, 10));
  input.write(`${line.slice(10)}\n{not json\n\n${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' })}\n`);
  await new Promise(done => setImmediate(done));
  const replies = output.read().toString().trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(replies.map(r => [r.id, r.error?.code ?? 'ok']), [[1, 'ok'], [null, -32700], [2, 'ok']]);
});

test('the tools: figures from the stats source, takeaways as sentences, settings without secrets', () => {
  const stats = (days, session) => ({
    range: { from: Date.UTC(2026, 9, 1), to: Date.UTC(2026, 9, 8), days: [7, 14, 30].includes(days) ? days : 14 },
    session: session ? { id: session, title: 'T', project: 'p' } : null,
    sessions: [{ id: 'ses_1', title: 'T', project: 'p', lastAt: Date.UTC(2026, 9, 7), toolCalls: 3 }],
    takeaways: [{ id: 'waited', tone: 'note', vars: { hours: 2, prompts: 5 }, anchor: 'stats-you' }, { id: 'cut_off', tone: 'act', vars: { n: 1, models: 'a/x' }, anchor: 'stats-agent' }],
    compare: null,
    daily: [{ date: '2026-10-01' }],
    totals: { sessions: 1 },
    speed: { models: [{ model: 'a/x' }, { model: 'b/unknown' }] },
  });
  const en = JSON.parse(readFileSync(join(ROOT, 'i18n', 'en.json'), 'utf8'));
  const t = (key, vars = {}) => (en[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => vars[name] ?? '');
  const opencode = {
    limits: new Map([['a/x', 100_000]]),
    reserves: new Map([['a/x', { output: 8000, input: null }]]),
    compaction: {},
    mcp: [{ name: 'trivy', type: 'local', enabled: true, command: ['trivy', '--token', 'SECRET'] }],
    providers: [{ id: 'a', baseURL: 'http://10.0.0.5:8080/v1' }],
  };
  const configDir = resolve('/home/u/.config/opencode');
  const changes = [{ t: Date.UTC(2026, 9, 5), file: join(configDir, 'opencode.json'), changes: [{ path: 'model', kind: 'changed', from: 'a/x', to: 'a/y' }], more: 0 }];
  const tools = buildTools({ stats, opencode, cfg: { opencodeConfigDir: configDir }, t, configChanges: { list: () => changes }, redact: s => s, now: () => Date.UTC(2026, 9, 8) });
  const run = (name, args = {}) => tools.find(tool => tool.name === name).run(args);

  const took = run('opencode_takeaways', { days: 7 });
  assert.equal(took.period.days, 7);
  assert.deepEqual(took.takeaways[0], { what: 'In all, the agent waited 2 h for your answer to 5 questions and permission prompts.', toChange: false, figures: { hours: 2, prompts: 5 }, chapter: 'you' });
  assert.equal(took.takeaways[1].toChange, true);

  const figures = run('opencode_stats', { session: 'ses_1' });
  assert.equal(figures.session.id, 'ses_1');
  assert.deepEqual(figures.totals, { sessions: 1 });
  // The list of sessions has its own tool, and the days come only when asked for.
  assert.equal('sessions' in figures, false);
  assert.equal('daily' in figures, false);
  assert.equal(run('opencode_stats', { daily: true }).daily.length, 1);
  assert.equal(run('opencode_sessions').sessions[0].lastAt, '2026-10-07T00:00:00.000Z');

  const settings = run('opencode_settings');
  assert.deepEqual(settings.models, [
    { model: 'a/x', context: 100_000, input: null, output: 8000, compactsAt: 92_000 },
    { model: 'b/unknown', context: null, input: null, output: null, compactsAt: null },
  ]);
  assert.deepEqual(settings.mcpServers, [{ name: 'trivy', type: 'local', enabled: true }]);
  assert.doesNotMatch(JSON.stringify(settings), /SECRET|10\.0\.0\.5|token/);

  const changed = run('opencode_config_changes', { days: 99 }).changes;
  assert.equal(changed[0].at, '2026-10-05T00:00:00.000Z');
  assert.equal(changed[0].global, true);
});

test('mcp.mjs: a real process speaks only the protocol on stdout, on sample data', async () => {
  const child = spawn(process.execPath, ['mcp.mjs', '--sample'], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', d => (out += d));
  child.stderr.on('data', d => (err += d));
  const send = m => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
  send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } });
  send({ method: 'notifications/initialized' });
  send({ id: 2, method: 'tools/list' });
  send({ id: 3, method: 'tools/call', params: { name: 'opencode_stats', arguments: { days: 7 } } });
  send({ id: 4, method: 'tools/call', params: { name: 'opencode_settings', arguments: {} } });
  send({ id: 5, method: 'tools/call', params: { name: 'opencode_takeaways', arguments: {} } });
  send({ id: 6, method: 'tools/call', params: { name: 'opencode_sessions', arguments: { days: 30 } } });
  send({ id: 7, method: 'tools/call', params: { name: 'opencode_config_changes', arguments: {} } });
  child.stdin.end();
  const code = await new Promise(done => child.on('close', done));
  assert.equal(code, 0, err);
  const replies = out.trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(replies.map(r => r.id), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(replies[1].result.tools.length, 5);
  for (const reply of replies.slice(2)) assert.equal(reply.result.isError, undefined, reply.result.content[0].text);
  const figures = JSON.parse(replies[2].result.content[0].text);
  assert.ok(figures.totals.toolCalls > 0);
  // The sample's planted secret never leaves, here as on the page.
  assert.ok(!/squ_[0-9a-f]{8}/.test(out));
  assert.match(err, /read-only/);
});

test('mcp.mjs refuses options that are not its own', async () => {
  const child = spawn(process.execPath, ['mcp.mjs', '--port', '1'], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', d => (out += d));
  child.stderr.on('data', d => (err += d));
  const code = await new Promise(done => child.on('close', done));
  assert.equal(code, 1);
  assert.equal(out, '');
  assert.match(err, /takes only --data-dir, --config and --sample/);
});
