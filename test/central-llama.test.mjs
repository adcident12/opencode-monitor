// OpenCode Central, the llama.cpp side: the hub keeps what the model server is doing (Llama Stroller, read only), the
// moments it changed (events), its figures per hour (InfluxDB, a small query an hour) and who used it (the home's
// usage page). Nothing here starts, stops or writes anything but the hub's own files; paths and keys never come in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sanitizeProfile, parseFluxCsv, createLlamaSource } from '../src/central/llama.mjs';

const H = 3_600_000;
const T0 = Date.parse('2026-11-14T10:20:00Z');
const PROFILE = {
  name: 'qwen-mtp', model: 'Qwen-MTP-GGUF/Qwen-Q4.gguf', host: '0.0.0.0', port: 11435, ctxSize: 131072, gpuLayers: 999, parallel: 1, flashAttn: 'on', cacheTypeK: 'q8_0', cacheTypeV: 'q8_0',
  extraArgs: '--alias qwen-mtp --cache-ram 0 --seed -1 --spec-draft-n-max 2 --api-key-file C:\\Users\\me\\secrets\\key.txt --mmproj C:\\models\\mm-F16.gguf --no-reasoning-preserve',
  note: 'n'.repeat(400),
};

test('a profile keeps its settings by name; key files, paths and addresses never come in', () => {
  const p = sanitizeProfile(PROFILE);
  assert.equal(p.model, 'Qwen-Q4.gguf');
  assert.equal(p.ctxSize, 131072);
  assert.deepEqual(p.args, { '--alias': 'qwen-mtp', '--cache-ram': '0', '--seed': '-1', '--spec-draft-n-max': '2', '--mmproj': 'mm-F16.gguf', '--no-reasoning-preserve': true });
  assert.equal(p.note.length, 300);
  const text = JSON.stringify(p);
  for (const bad of ['key.txt', 'secrets', 'Users', '0.0.0.0', 'api-key']) assert.ok(!text.includes(bad), bad);
});

test('InfluxDB CSV: rows by time and field, several tables, numbers', () => {
  const csv = ',result,table,_time,_field,_value\r\n,_result,0,2026-11-14T10:00:00Z,llamacpp:prompt_tokens_total,1200\r\n,_result,0,2026-11-14T11:00:00Z,llamacpp:prompt_tokens_total,300\r\n\r\n,result,table,_time,_field,_value\r\n,_result,1,2026-11-14T10:00:00Z,llamacpp:requests_deferred,2\r\n';
  assert.deepEqual(parseFluxCsv(csv), [
    { time: Date.parse('2026-11-14T10:00:00Z'), field: 'llamacpp:prompt_tokens_total', value: 1200 },
    { time: Date.parse('2026-11-14T11:00:00Z'), field: 'llamacpp:prompt_tokens_total', value: 300 },
    { time: Date.parse('2026-11-14T10:00:00Z'), field: 'llamacpp:requests_deferred', value: 2 },
  ]);
});

function fakeWorld() {
  const w = {
    now: T0,
    status: { running: true, healthy: true, loading: false, pid: 1, profile: 'qwen-mtp', host: '0.0.0.0', port: 11435, startedAt: '2026-11-14T03:00:00.000Z', uptimeMs: 1, logFile: 'C:\\x\\log.txt', gpu: [{ index: 0, name: 'RTX', memTotalMiB: 16000, memUsedMiB: 12000, utilPct: 3, tempC: 40 }] },
    profiles: [PROFILE],
    strollerDown: false,
    queries: [],
    usage: { d1: { gen: 10, prompt: 100 }, callers: [{ caller: 'ares', requests: 3 }], hours: [1, 2, 3] },
    calls: [],
  };
  w.fetch = async (url, init = {}) => {
    w.calls.push({ url: String(url), method: init.method ?? 'GET' });
    const u = new URL(url);
    if (u.port === '4570') {
      if (w.strollerDown) throw new Error('ECONNREFUSED');
      if (u.pathname === '/api/status') return new Response(JSON.stringify(w.status));
      if (u.pathname === '/api/profiles') return new Response(JSON.stringify({ profiles: w.profiles }));
      return new Response('no', { status: 404 });
    }
    if (u.pathname === '/api/v2/query') {
      const flux = String(init.body);
      const range = /range\(start: (\S+), stop: (\S+)\)/.exec(flux);
      w.queries.push({ start: range[1], stop: range[2], auth: init.headers?.Authorization });
      const start = Date.parse(range[1]);
      const stop = Date.parse(range[2]);
      let csv = ',result,table,_time,_field,_value\r\n';
      for (let t = start + H; t <= stop; t += H) {
        csv += `,_result,0,${new Date(t).toISOString()},llamacpp:prompt_tokens_total,1000\r\n,_result,0,${new Date(t).toISOString()},llamacpp:prompt_seconds_total,2\r\n`;
        csv += `,_result,0,${new Date(t).toISOString()},llamacpp:tokens_predicted_total,100\r\n,_result,0,${new Date(t).toISOString()},llamacpp:tokens_predicted_seconds_total,4\r\n`;
      }
      return new Response(csv);
    }
    if (u.search === '?api=ai_usage') return new Response(JSON.stringify(w.usage));
    return new Response('?', { status: 404 });
  };
  return w;
}

function withSource(fn, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ocm-llama-'));
  const w = fakeWorld();
  const make = (more = {}) => createLlamaSource({ dir, stroller: 'http://stroller.test:4570', influx: { url: 'http://influx.test:8086', org: 'home', bucket: 'ai', token: 'tok' }, usageUrl: 'http://dash.test:8084/?api=ai_usage', fetch: w.fetch, now: () => w.now, ...overrides, ...more });
  return Promise.resolve(fn({ dir, w, make })).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test('the first look is a "seen" event; nothing changed, nothing new; a hub restart does not see it again', () => withSource(async ({ w, make }) => {
  const s = make();
  await s.poll();
  assert.deepEqual(s.events(0).map(e => e.kind), ['seen']);
  assert.equal(s.now().profile, 'qwen-mtp');
  assert.equal(s.now().settings.ctxSize, 131072);
  assert.ok(!JSON.stringify(s.now()).includes('log.txt'));
  w.now += 60_000;
  await s.poll();
  assert.equal(s.events(0).length, 1);
  const again = make();
  await again.poll();
  assert.equal(again.events(0).length, 1);
}));

test('a restart, a profile change, a changed setting and a stop are each an event with what changed', () => withSource(async ({ w, make }) => {
  const s = make();
  await s.poll();
  w.now += 60_000; w.status = { ...w.status, startedAt: '2026-11-14T10:21:00.000Z' };
  await s.poll();
  w.now += 60_000; w.profiles = [{ ...PROFILE, ctxSize: 65536 }];
  await s.poll();
  w.now += 60_000; w.profiles = [...w.profiles, { ...PROFILE, name: 'other' }]; w.status = { ...w.status, profile: 'other', startedAt: '2026-11-14T10:23:00.000Z' };
  await s.poll();
  w.now += 60_000; w.status = { running: false, healthy: false, loading: false, gpu: [] };
  await s.poll();
  const ev = s.events(0);
  assert.deepEqual(ev.map(e => e.kind), ['seen', 'restart', 'settings', 'profile', 'stopped']);
  assert.deepEqual(ev[2].changes, [{ key: 'ctxSize', from: 131072, to: 65536 }]);
  assert.deepEqual([ev[3].from, ev[3].to], ['qwen-mtp', 'other']);
}));

test('Stroller down: no event, no throw, and now() says it could not be read', () => withSource(async ({ w, make }) => {
  const s = make();
  w.strollerDown = true;
  await s.poll();
  assert.equal(s.events(0).length, 0);
  assert.match(s.now().error, /not reachable/i);
}));

test('only GET reaches Stroller, only its status and profiles', () => withSource(async ({ w, make }) => {
  await make().poll();
  for (const c of w.calls.filter(c => c.url.includes(':4570'))) {
    assert.equal(c.method, 'GET');
    assert.match(new URL(c.url).pathname, /^\/api\/(status|profiles)$/);
  }
}));

test('hourly figures: 7 days back on the first poll, then only the hours not yet asked', () => withSource(async ({ w, make }) => {
  const s = make();
  await s.poll();
  assert.equal(w.queries.length, 1);
  const hourStart = Math.floor(T0 / H) * H;
  assert.equal(Date.parse(w.queries[0].stop), hourStart);
  assert.equal(Date.parse(w.queries[0].start), hourStart - 7 * 24 * H);
  assert.equal(w.queries[0].auth, 'Token tok');
  w.now += 20 * 60_000; // same hour
  await s.poll();
  assert.equal(w.queries.length, 1, 'nothing new to ask');
  w.now += 60 * 60_000; // the next hour is complete
  await s.poll();
  assert.equal(w.queries.length, 2);
  assert.equal(Date.parse(w.queries[1].start), hourStart - 2 * H, 'the newest two hours are asked once more');
  const rows = s.hourly(hourStart - 2 * H, hourStart + H);
  assert.deepEqual(rows.map(r => r.t), [hourStart - 2 * H, hourStart - H, hourStart]);
  assert.deepEqual([rows[0].prompt, rows[0].prompt_s, rows[0].gen, rows[0].gen_s], [1000, 2, 100, 4]);
  // kept on disk, read back by a new source without asking again
  const again = make();
  await again.poll();
  assert.equal(w.queries.length, 2);
  assert.equal(again.hourly(hourStart, hourStart + H).length, 1);
}));

test('no InfluxDB settings: no query, no hours, the rest still works', () => withSource(async ({ w, make }) => {
  const s = make({ influx: null });
  await s.poll();
  assert.equal(w.queries.length, 0);
  assert.deepEqual(s.hourly(0, Infinity), []);
  assert.equal(s.now().profile, 'qwen-mtp');
}));

test('callers from the usage page, at most every 5 minutes, only what is needed', () => withSource(async ({ w, make }) => {
  const s = make();
  await s.poll();
  assert.deepEqual(s.callers().callers, [{ caller: 'ares', requests: 3 }]);
  assert.ok(!('hours' in s.callers()));
  w.now += 60_000;
  await s.poll();
  assert.equal(w.calls.filter(c => c.url.includes('ai_usage')).length, 1);
  w.now += 5 * 60_000;
  await s.poll();
  assert.equal(w.calls.filter(c => c.url.includes('ai_usage')).length, 2);
}));

test('the events file has no paths or keys', () => withSource(async ({ dir, w, make }) => {
  const s = make();
  await s.poll();
  w.now += 60_000; w.profiles = [{ ...PROFILE, extraArgs: `${PROFILE.extraArgs} --lora C:\\models\\x.gguf` }];
  await s.poll();
  const file = join(dir, 'llama-events.jsonl');
  assert.ok(existsSync(file));
  const text = readFileSync(file, 'utf8');
  assert.ok(text.includes('x.gguf'));
  for (const bad of ['C:\\\\', 'key.txt', 'secrets']) assert.ok(!text.includes(bad), bad);
}));

test('review: an hour is settled only 10 minutes after it ends, and the last two are asked again', () => withSource(async ({ w, make }) => {
  const s = make();
  w.now = Date.parse('2026-11-14T11:05:00Z');
  await s.poll();
  assert.equal(new Date(Date.parse(w.queries[0].stop)).toISOString(), '2026-11-14T10:00:00.000Z', '10-11 is not settled at 11:05');
  w.now = Date.parse('2026-11-14T11:12:00Z');
  await s.poll();
  assert.equal(w.queries.length, 2);
  assert.equal(w.queries[1].start, '2026-11-14T08:00:00.000Z');
  assert.equal(w.queries[1].stop, '2026-11-14T11:00:00.000Z');
}));

test('review: an error table from InfluxDB is a failure, not an empty hour', () => {
  assert.throws(() => parseFluxCsv(',error,reference\r\n,some flux error,\r\n'), /InfluxDB/);
  assert.deepEqual(parseFluxCsv('\r\n'), []);
});

test('review: a settings change saved with a restart, or while stopped, keeps what changed', () => withSource(async ({ w, make }) => {
  const s = make();
  await s.poll();
  w.now += 60_000; w.profiles = [{ ...PROFILE, ctxSize: 65536 }]; w.status = { ...w.status, startedAt: '2026-11-14T10:21:00.000Z' };
  await s.poll();
  w.now += 60_000; w.status = { running: false, gpu: [] };
  await s.poll();
  w.now += 60_000; w.profiles = [{ ...PROFILE, ctxSize: 32768 }];
  await s.poll();
  w.now += 60_000; w.status = { ...fakeWorld().status, startedAt: '2026-11-14T10:25:00.000Z' };
  await s.poll();
  const ev = s.events(0);
  assert.deepEqual(ev.map(e => e.kind), ['seen', 'restart', 'stopped', 'started']);
  assert.deepEqual(ev[1].changes, [{ key: 'ctxSize', from: 131072, to: 65536 }]);
  assert.deepEqual(ev[3].changes, [{ key: 'ctxSize', from: 65536, to: 32768 }]);
}));

test('review: tokens, secrets and addresses among the flags are left out', () => {
  const p = sanitizeProfile({ name: 'x', extraArgs: '--hf-token hf_abc -hft hf_def --host 192.168.0.53 --port 11435 --path C:\web --ssl-key-file k.pem --alias ok' });
  assert.deepEqual(p.args, { '--alias': 'ok' });
});

test('review: a malformed Stroller answer still lets the hours and the callers be read', () => withSource(async ({ w, make }) => {
  const s = make();
  w.profiles = 'nope';
  w.status = { running: true, profile: 'qwen-mtp', gpu: 'nope' };
  await s.poll();
  assert.equal(w.queries.length, 1);
  assert.ok(s.callers());
}));

test('a new llama.cpp build (from Stroller) is its own event, with from and to; nothing else from that field', () => withSource(async ({ w, make }) => {
  const s = make();
  w.status = { ...w.status, build: { number: 9949, commit: '049326a00', path: 'C:\\llama\\bin' } };
  await s.poll();
  assert.deepEqual(s.now().build, { number: 9949, commit: '049326a00' });
  w.now += 60_000; w.status = { ...w.status, build: { number: 9960, commit: 'abcdef123' }, startedAt: '2026-11-14T10:30:00.000Z' };
  await s.poll();
  w.now += 60_000; w.status = { ...w.status, startedAt: '2026-11-14T10:31:00.000Z' };
  await s.poll();
  const ev = s.events(0);
  assert.deepEqual(ev.map(e => e.kind), ['seen', 'build', 'restart']);
  assert.deepEqual([ev[1].from, ev[1].to], ['9949 (049326a00)', '9960 (abcdef123)']);
}));

test('a build field that is not a number and a short hex is not kept', () => withSource(async ({ w, make }) => {
  const s = make();
  w.status = { ...w.status, build: { number: 'C:\\x', commit: 'not hex!' } };
  await s.poll();
  assert.equal(s.now().build, null);
}));
