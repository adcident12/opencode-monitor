// npm run verify: checks the figures the page shows against this machine's own data.
//
// Starts a monitor of its own on a free port (notifications and history off, so the monitor you
// use is never disturbed and nothing is sent or written), asks it what the page would show, and
// recomputes the same figures here with separate SQL and log parsing that share no counting
// code with the monitor. Every figure that differs is printed; the exit code is 1 if any does.
//
// Read-only like the monitor: the database is opened read-only, the log only read.
//
//   node scripts/verify.mjs [--data-dir <path>] [--config <path>]
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig, parseArgs } from '../src/config.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = parseArgs(process.argv.slice(2));
const cfg = loadConfig(args);
const dbPath = join(cfg.dataDir, 'opencode.db');
if (!existsSync(dbPath)) {
  console.error(`No OpenCode database at ${dbPath}: nothing to verify.`);
  process.exit(1);
}

// ---------------------------------------------------------------- a monitor of our own
const freePort = () => new Promise(done => {
  const probe = createServer().listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => done(port));
  });
});
const port = await freePort();
const tmp = mkdtempSync(join(tmpdir(), 'ocm-verify-'));
const configPath = join(tmp, 'config.json');
const own = existsSync(cfg.configFile?.path ?? '') ? JSON.parse(readFileSync(cfg.configFile.path, 'utf8')) : {};
writeFileSync(configPath, JSON.stringify({
  ...own,
  port,
  dataDir: cfg.dataDir,
  opencodeConfigDir: cfg.opencodeConfigDir,
  history: { ...own.history, enabled: false },
  notify: { ...own.notify, on: [], environment: false, desktop: false, discord: { webhookUrl: '' } },
}));
const child = spawn(process.execPath, ['server.mjs', '--config', configPath, '--no-notify'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
let childOut = '';
child.stdout.on('data', c => (childOut += c));
child.stderr.on('data', c => (childOut += c));
const stop = () => {
  child.kill();
  rmSync(tmp, { recursive: true, force: true });
};
process.on('exit', stop);

const base = `http://127.0.0.1:${port}`;
const get = async path => {
  const res = await fetch(base + path);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
};
for (let i = 0; ; i++) {
  try {
    await get('/api/state');
    break;
  } catch {
    if (i > 100 || child.exitCode != null) {
      console.error(`The monitor did not start:\n${childOut}`);
      process.exit(1);
    }
    await new Promise(r => setTimeout(r, 200));
  }
}

// ---------------------------------------------------------------- independent counts
const db = new DatabaseSync(dbPath, { readOnly: true });
const one = (sql, ...a) => db.prepare(sql).get(...a);
const all = (sql, ...a) => db.prepare(sql).all(...a);
const START = `coalesce(json_extract(data,'$.state.time.start'), time_created)`;
const SENT = `coalesce(json_extract(data,'$.tokens.input'),0)+coalesce(json_extract(data,'$.tokens.cache.read'),0)+coalesce(json_extract(data,'$.tokens.cache.write'),0)`;
const fold = path => (process.platform === 'win32' ? path.replaceAll('\\', '/').toLowerCase() : path);
const parse = text => {
  try {
    return JSON.parse(text ?? 'null');
  } catch {
    return null;
  }
};

const sessions = all('select id, parent_id from session');
const family = id => {
  const set = new Set([id]);
  for (let grew = true; grew;) {
    grew = false;
    for (const s of sessions) if (s.parent_id && set.has(s.parent_id) && !set.has(s.id)) { set.add(s.id); grew = true; }
  }
  return [...set];
};
const rootOf = id => {
  const parent = new Map(sessions.map(s => [s.id, s.parent_id]));
  let x = id;
  for (let i = 0; i < 20 && parent.get(x); i++) x = parent.get(x);
  return x;
};
const within = ids => (ids ? ` and session_id in (${ids.map(() => '?').join(',')})` : '');

/** The figures of one Stats view, recomputed for the same range and, optionally, one session. */
function count(from, to, ids = null) {
  const s = ids ?? [];
  const f = {};
  const tools = one(`select count(*) n, coalesce(sum(json_extract(data,'$.state.status')='error'),0) e from part where json_extract(data,'$.type')='tool' and ${START} between ? and ?${within(ids)}`, from, to, ...s);
  f.toolCalls = tools.n;
  f.toolErrors = tools.e;
  f.compactions = one(`select count(*) n from part where json_extract(data,'$.type')='compaction' and time_created between ? and ?${within(ids)}`, from, to, ...s).n;
  f.activeMs = one(`select coalesce(sum(max(0, min(coalesce(json_extract(data,'$.time.completed'), time_created), ?) - max(time_created, ?))),0) ms from message where json_extract(data,'$.role')='assistant'${within(ids)}`, to, from, ...s).ms;
  const u = one(`select count(*) n, coalesce(sum(i),0) i, coalesce(sum(r),0) r, coalesce(sum(o),0) o, coalesce(sum(c),0) c from (select coalesce(json_extract(data,'$.tokens.input'),0) i, coalesce(json_extract(data,'$.tokens.cache.read'),0) r,
      coalesce(json_extract(data,'$.tokens.cache.write'),0) w, coalesce(json_extract(data,'$.tokens.output'),0) o, coalesce(json_extract(data,'$.cost'),0) c
    from message where json_extract(data,'$.role')='assistant' and time_created between ? and ?${within(ids)}) where i + r + w + o > 0`, from, to, ...s);
  f.requests = u.n;
  f.tokensSent = u.i + u.r;
  f.tokensOutput = u.o;
  f.cost = Math.round(u.c * 1e4) / 1e4;
  if (!ids) f.sessions = one(`select count(*) n from session where parent_id is null and time_created between ? and ?`, from, to).n;
  const patches = all(`select json_extract(data,'$.files') f from part where json_extract(data,'$.type')='patch' and time_created between ? and ?${within(ids)}`, from, to, ...s).map(r => parse(r.f) ?? []).filter(x => x.length);
  f.edits = patches.length;
  f.filesChanged = new Set(patches.flat().map(fold)).size;
  const spans = one(`select coalesce(sum(case when json_extract(data,'$.type')='reasoning' then e - st end),0) think, coalesce(sum(case when json_extract(data,'$.type')='text' then e - st end),0) write from (
      select data, json_extract(data,'$.time.start') st, json_extract(data,'$.time.end') e from part
      where json_extract(data,'$.type') in ('reasoning','text') and json_extract(data,'$.time.start') between ? and ? and json_extract(data,'$.time.end') > json_extract(data,'$.time.start')${within(ids)})`, from, to, ...s);
  f.thinkingMs = spans.think;
  f.writingMs = spans.write;
  return f;
}
const shown = stats => ({
  toolCalls: stats.totals.toolCalls,
  toolErrors: stats.totals.toolErrors,
  compactions: stats.totals.compactions,
  activeMs: stats.totals.activeMs,
  requests: stats.usage.requests,
  tokensSent: stats.usage.input + stats.usage.cacheRead + stats.usage.cacheWrite,
  tokensOutput: stats.usage.output,
  cost: Math.round(stats.usage.cost * 1e4) / 1e4,
  ...(stats.session ? {} : { sessions: stats.totals.sessions }),
  edits: stats.work.files.edits,
  filesChanged: stats.work.files.files,
  thinkingMs: stats.work.time.thinkingMs,
  writingMs: stats.work.time.writingMs,
});

// ---------------------------------------------------------------- compare
const rows = [];
const compare = (area, name, independent, monitor) => rows.push({ area, name, independent, monitor, ok: JSON.stringify(independent) === JSON.stringify(monitor) });

// OpenCode may be writing while this runs: a figure that differs is fetched and counted again
// once before it is reported, so a call recorded between the two counts is not called a bug.
async function view(area, path, ids = null) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const stats = await get(path);
    const mine = count(stats.range.from, stats.range.to, ids);
    const theirs = shown(stats);
    const same = Object.keys(mine).every(k => JSON.stringify(mine[k]) === JSON.stringify(theirs[k]));
    if (same || attempt === 1) {
      for (const k of Object.keys(mine)) compare(area, k, mine[k], theirs[k]);
      return stats;
    }
    await new Promise(r => setTimeout(r, 61_000)); // past the monitor's one-minute cache
  }
}

const views = {};
for (const days of [7, 14, 30]) views[days] = await view(`Stats, ${days} days`, `/api/stats?days=${days}`);
const s30 = views[30];

for (const d of [7, 14, 30]) {
  const v = views[d];
  for (const key of ['toolCalls', 'compactions', 'activeMs']) compare(`Stats, ${d} days`, `days add up: ${key}`, v.daily.reduce((n, x) => n + x[key], 0), v.totals[key]);
}

for (const s of s30.sessions.slice(0, 5)) {
  const one30 = await view(`Stats, session "${s.title.slice(0, 30)}"`, `/api/stats?days=30&session=${s.id}`, family(s.id));
  compare(`Stats, session "${s.title.slice(0, 30)}"`, 'its row in History = this view (agent time)', one30.totals.activeMs, s.activeMs);
}

// MCP rows
const prefixes = s30.mcp.map(m => m.name.replace(/[^a-zA-Z0-9_-]/g, '_') + '_');
const mcpCalls = all(`select json_extract(data,'$.tool') tool, json_extract(data,'$.state.status') st from part where json_extract(data,'$.type')='tool' and ${START} between ? and ?`, s30.range.from, s30.range.to);
for (const m of s30.mcp.filter(x => x.calls > 0)) {
  const p = m.name.replace(/[^a-zA-Z0-9_-]/g, '_') + '_';
  // The longest matching prefix wins, as in the monitor.
  const owned = mcpCalls.filter(c => c.tool?.startsWith(p) && !prefixes.some(q => q.length > p.length && c.tool.startsWith(q)));
  compare('MCP servers', `${m.name}: calls`, owned.length, m.calls);
  compare('MCP servers', `${m.name}: failed`, owned.filter(c => c.st === 'error').length, m.errors + m.faults);
}

// Model speed, same definition, from raw parts
const top = s30.speed.models[0];
if (top) {
  const slash = top.model.indexOf('/');
  const msgs = all(`select coalesce(json_extract(m.data,'$.tokens.output'),0) + coalesce(json_extract(m.data,'$.tokens.reasoning'),0) out,
      (select min(p.time_created) from part p where p.message_id = m.id and json_extract(p.data,'$.type')='step-start') ft,
      (select max(case json_extract(p.data,'$.type') when 'tool' then json_extract(p.data,'$.state.time.start') when 'text' then json_extract(p.data,'$.time.end') when 'reasoning' then json_extract(p.data,'$.time.end') end) from part p where p.message_id = m.id) wr
    from message m where json_extract(m.data,'$.role')='assistant' and json_extract(m.data,'$.providerID')=? and json_extract(m.data,'$.modelID')=? and m.time_created between ? and ?`,
  top.model.slice(0, slash), top.model.slice(slash + 1), s30.range.from, s30.range.to);
  let tokens = 0;
  let ms = 0;
  for (const r of msgs) if (r.ft != null && r.wr != null && r.out >= 20 && r.wr - r.ft >= 300) { tokens += r.out; ms += r.wr - r.ft; }
  compare('Model speed', `${top.model} writing (tok/s)`, ms ? Math.round((tokens / ms) * 10_000) / 10 : null, top.writeTps);
}

// Sessions on the Now tab
const state = await get('/api/state');
for (const s of state.sessions.filter(x => !x.parentId).slice(0, 5)) {
  const area = `Now, "${s.title.slice(0, 30)}"`;
  const p = one(`select coalesce(sum(json_extract(data,'$.type')='tool'),0) t, coalesce(sum(json_extract(data,'$.type')='tool' and json_extract(data,'$.state.status')='error'),0) e, coalesce(sum(json_extract(data,'$.type')='compaction'),0) c from part where session_id = ?`, s.id);
  compare(area, 'tool calls', p.t, s.health.toolCalls);
  compare(area, 'failed', p.e, s.health.toolErrors);
  compare(area, 'compactions', p.c, s.health.compactions);
  const files = new Set([
    ...all(`select json_extract(data,'$.state.input.filePath') f from part where session_id = ? and json_extract(data,'$.tool') in ('edit','write','multiedit','apply_patch') and json_extract(data,'$.state.status')='completed'`, s.id).map(r => r.f).filter(Boolean),
    ...all(`select json_extract(data,'$.files') f from part where session_id = ? and json_extract(data,'$.type')='patch'`, s.id).flatMap(r => parse(r.f) ?? []),
  ].map(fold));
  compare(area, 'files touched', files.size, s.work.files.count);
}

// This machine: models in use
const setup = await get('/api/setup');
for (const m of setup.models) {
  const slash = m.id.indexOf('/');
  compare('This machine', `${m.id}: replies, 30 days`, one(`select count(*) n from message where json_extract(data,'$.role')='assistant' and json_extract(data,'$.providerID')=? and json_extract(data,'$.modelID')=? and time_created >= ?`, m.id.slice(0, slash), m.id.slice(slash + 1), Date.now() - 30 * 86_400_000).n, m.requests);
}

// Prompts that waited for you, from the log's own lines
const logPath = join(cfg.dataDir, 'log', 'opencode.log');
if (existsSync(logPath)) {
  const log = readFileSync(logPath, 'utf8');
  for (const d of [7, 30]) {
    const v = views[d];
    const n = [...log.matchAll(/^timestamp=(\S+) level=\S+ run=\S+ message=asking id=(?:per|que)_/gm)].map(m => Date.parse(m[1])).filter(t => t >= v.range.from && t <= v.range.to).length;
    compare(`Stats, ${d} days`, 'prompts that waited for you', n, v.totals.prompts);
  }
}

// ---------------------------------------------------------------- report
const bad = rows.filter(r => !r.ok);
let area = '';
for (const r of rows) {
  if (r.area !== area) {
    area = r.area;
    console.log(`\n${area}`);
  }
  console.log(`  ${r.ok ? 'ok  ' : 'DIFF'} ${r.name.padEnd(46)} ${String(r.independent).padStart(14)} ${r.ok ? '' : `  monitor shows ${r.monitor}`}`);
}
console.log(`\n${rows.length - bad.length} of ${rows.length} figures agree with an independent count of this machine's data.`);
if (bad.length) console.log('Figures that differ are a bug: please report them with this output (it holds counts only, no content).');
process.exit(bad.length ? 1 : 0);
