// OpenCode Central: the key figures of each batch become InfluxDB points (bucket "opencode") so Grafana, alerts and
// Ares can read them beside llama.cpp's. Only numbers, statuses and names; the time is the event's own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toLines, createInfluxExport, escapeTag } from '../src/central/influx.mjs';

const T = 1_800_000_000_000;
const sessions = new Map([['s1', '/poppy/shop api'], ['s2', '/poppy/web']]);
const models = new Map([['m1', { providerID: 'llama', modelID: 'qwen3.6' }]]);
const lookup = { projectOf: id => sessions.get(id)?.split('/').pop() ?? null, modelOf: id => models.get(id) ?? null };
const part = (id, data, t = T) => ({ id, message_id: 'm1', session_id: 's1', time_created: t, time_updated: t, data: JSON.stringify(data) });

test('a step-finish is one request: tokens, cache and cost, tagged by machine, project and model', () => {
  const lines = toLines({ rows: { part: [part('p1', { type: 'step-finish', cost: 0.002, tokens: { input: 900, output: 120, reasoning: 30, cache: { read: 700, write: 10 } } })] } }, 'poppy', lookup);
  assert.deepEqual(lines, [`opencode_request,machine=poppy,project=shop\\ api,provider=llama,model=qwen3.6 tokens_in=900,tokens_out=120,reasoning=30,cache_read=700,cache_write=10,cost=0.002 ${T}`]);
});

test('a finished tool call: its time and status; a running one is not written yet', () => {
  const lines = toLines({ rows: { part: [
    part('p2', { type: 'tool', tool: 'bash', state: { status: 'completed', time: { start: T, end: T + 1500 }, input: { '#': '#abc' } } }),
    part('p3', { type: 'tool', tool: 'read', state: { status: 'running', time: { start: T } } }),
  ] } }, 'poppy', lookup);
  assert.deepEqual(lines, [`opencode_tool,machine=poppy,project=shop\\ api,tool=bash,status=completed duration_ms=1500 ${T + 1500}`]);
});

test('a compaction is counted, auto or not', () => {
  assert.deepEqual(toLines({ rows: { part: [part('p4', { type: 'compaction', auto: true })] } }, 'poppy', lookup),
    [`opencode_compaction,machine=poppy,project=shop\\ api,auto=true n=1 ${T}`]);
});

test('OpenCode 2: an assistant message is one request, its tool calls are tool points', () => {
  const row = { id: 'x1', session_id: 's2', type: 'assistant', seq: 1, time_created: T, time_updated: T + 9000, data: JSON.stringify({
    model: { providerID: 'llama', id: 'qwen' }, cost: 0, tokens: { input: 5000, output: 400, reasoning: 100, cache: { read: 4000, write: 0 } },
    time: { created: T, completed: T + 9000 },
    content: [{ type: 'tool', name: 'shell', time: { created: T + 1000, ran: T + 1200, completed: T + 3200 }, state: { status: 'completed' } }] }) };
  const lines = toLines({ rows: { session_message: [row] } }, 'poppy', lookup);
  assert.deepEqual(lines, [
    `opencode_request,machine=poppy,project=web,provider=llama,model=qwen tokens_in=5000,tokens_out=400,reasoning=100,cache_read=4000,cache_write=0,cost=0,duration_ms=9000 ${T}`,
    `opencode_tool,machine=poppy,project=web,tool=bash,status=completed duration_ms=2000 ${T + 3200}`,
  ]);
});

test('nothing but numbers and names: no title, filler or hash ever in a line', () => {
  const lines = toLines({ rows: { session: [{ id: 's1', title: 'secret plan', directory: '/poppy/shop api' }], part: [
    part('p5', { type: 'tool', tool: 'bash', state: { status: 'error', time: { start: T, end: T + 5 }, error: '·····', input: { '#': '#0123456789abcdef··' } } })] } }, 'poppy', lookup);
  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines.join('\n'), /secret plan|·|#[0-9a-f]{16}/);
});

test('tag values are escaped; an unknown project or model is "unknown"', () => {
  assert.equal(escapeTag('a b,c=d'), 'a\\ b\\,c\\=d');
  const lines = toLines({ rows: { part: [{ ...part('p6', { type: 'compaction', auto: false }), session_id: 'gone' }] } }, 'poppy', lookup);
  assert.match(lines[0], /project=unknown/);
});

test('the export posts the lines with the token, and a failing InfluxDB never throws', async () => {
  const calls = [];
  const ok = createInfluxExport({ url: 'http://influx:8086', org: 'home', bucket: 'opencode', token: 'tok', send: async (url, init) => { calls.push([url, init]); return { ok: true, status: 204 }; } });
  await ok.write(['a x=1 1']);
  assert.match(calls[0][0], /\/api\/v2\/write\?org=home&bucket=opencode&precision=ms$/);
  assert.equal(calls[0][1].headers.Authorization, 'Token tok');
  assert.equal(calls[0][1].body, 'a x=1 1');
  const bad = createInfluxExport({ url: 'http://influx:8086', org: 'home', bucket: 'opencode', token: 't', send: async () => { throw new Error('down'); } });
  await bad.write(['a x=1 1']);
  await ok.write([]);
  assert.equal(calls.length, 1, 'nothing to write: no request');
});
