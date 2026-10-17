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
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig, parseArgs } from '../src/config.mjs';
import { trimEndOf } from '../src/text.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const startedAt = Date.now();
// Set for the second run, after OpenCode wrote while the first was counting.
const AGAIN = process.env.OCM_VERIFY_AGAIN === '1';
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
const get = async (path, retried = false) => {
  let res;
  try {
    res = await fetch(base + path);
  } catch (err) {
    // A kept-alive connection the monitor closed as it was being reused: asked again, once.
    if (retried || err.cause?.code !== 'ECONNRESET') throw err;
    return get(path, true);
  }
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
// A database made by OpenCode 2 alone has no 1.x tables: counted as empty ones, held in
// memory by this connection, so the same SQL runs. The file itself stays read-only.
for (const [table, columns] of Object.entries({ session: 'id, parent_id, time_created', message: 'id, session_id, time_created, data', part: 'id, message_id, session_id, time_created, time_updated, data' })) {
  if (!db.prepare(`pragma table_info(${table})`).all().length) db.exec(`pragma temp_store = memory; create temp table ${table} (${columns})`);
}
const one = (sql, ...a) => db.prepare(sql).get(...a);

const all = (sql, ...a) => db.prepare(sql).all(...a);
// The latest moment OpenCode wrote anything this counts from: if it moves while this runs, a
// session was working, and a figure counted a moment apart from the monitor's can differ.
const lastWrite = () => Math.max(
  ...['message', 'part'].map(t => one(`select max(time_updated) t from ${t}`)?.t ?? 0),
  ...(all("select name from sqlite_master where type = 'table' and name = 'session_message'").length ? [one('select max(time_updated) t from session_message')?.t ?? 0] : []),
);
const writtenAtStart = lastWrite();
const START = `coalesce(json_extract(data,'$.state.time.start'), time_created)`;
const SENT = `coalesce(json_extract(data,'$.tokens.input'),0)+coalesce(json_extract(data,'$.tokens.cache.read'),0)+coalesce(json_extract(data,'$.tokens.cache.write'),0)`;
// A path inside the session's project, as the project sees it: one file however it was written.
const underRoot = (path, root) => {
  const p = String(path).replaceAll('\\', '/');
  const r = trimEndOf(String(root ?? '').replaceAll('\\', '/'), '/');
  const inside = r && (process.platform === 'win32' ? p.toLowerCase().startsWith(`${r.toLowerCase()}/`) : p.startsWith(`${r}/`));
  return inside ? p.slice(r.length + 1) : p;
};
const fold = path => (process.platform === 'win32' ? path.replaceAll('\\', '/').toLowerCase() : path);
const parse = text => {
  try {
    return JSON.parse(text ?? 'null');
  } catch {
    return null;
  }
};

// OpenCode 2 keeps its sessions in tables of its own, and copied every 1.x session into them.
// Counted from there: only what is later than the last 1.x message of the same session.
const hasV2 = all("select name from sqlite_master where type = 'table' and name in ('session_v2', 'session_message')").length === 2;
// Read again before each view: OpenCode may be writing while this runs, and a count made from
// rows read a minute ago would be called a difference.
let v2 = [];
let forkedAt = new Map();
let v2Replies = [];
let v2Sessions = [];
let v2Calls = [];
let v2Compactions = [];
let sessions = [];
const sent = d => (d.tokens?.input ?? 0) + (d.tokens?.cache?.read ?? 0) + (d.tokens?.cache?.write ?? 0);
const mcpOf = item => (item.name === 'execute' ? (item.state?.metadata?.toolCalls ?? []).filter(c => String(c.tool).includes('.')) : []);
function readV2() {
  forkedAt = new Map(hasV2 && all("select name from pragma_table_info('session_v2') where name = 'fork_session_id'").length
    ? all('select id, time_created from session_v2 where fork_session_id is not null').map(s => [s.id, s.time_created])
    : []);
  v2 = (hasV2 ? all(`select sm.id, sm.session_id, sm.type, sm.time_created, sm.time_updated, sm.data from session_message sm
      where sm.time_created > coalesce((select max(m.time_created) from message m where m.session_id = sm.session_id), -1)
      order by sm.session_id, sm.time_created, sm.seq`) : [])
    // A fork's copy of its parent's history is the parent's work.
    .filter(r => !forkedAt.has(r.session_id) || r.time_created >= forkedAt.get(r.session_id))
    .map(r => ({ ...r, d: parse(r.data) ?? {} }));
  v2Replies = v2.filter(r => r.type === 'assistant');
  v2Sessions = hasV2 ? all('select id, parent_id, time_created from session_v2 where id not in (select id from session)') : [];
  // Every tool call OpenCode 2 recorded: an execute script is the MCP calls it made, if any.
  v2Calls = v2Replies.flatMap(r => (r.d.content ?? []).filter(i => i.type === 'tool').flatMap(item => {
    const at = item.time?.ran ?? item.time?.created ?? r.time_created;
    const inner = mcpOf(item);
    if (!inner.length) return [{ session_id: r.session_id, at, tool: { shell: 'bash', subagent: 'task' }[item.name] ?? item.name, error: item.state?.status === 'error', item }];
    return inner.map(c => ({ session_id: r.session_id, at, tool: c.tool.replace('.', '_'), error: (c.status ?? item.state?.status) === 'error', item }));
  }));
  // When a compaction ended: its row's last update, but never after the session's next row.
  v2Compactions = v2.map((r, i) => ({ r, next: v2[i + 1] })).filter(x => x.r.type === 'compaction').map(({ r, next }) => {
    const bound = next?.session_id === r.session_id ? next.time_created : Infinity;
    const going = r.d.status === 'running' || r.d.status === 'pending';
    return { ...r, ended: going ? r.time_created : Math.min(r.time_updated, bound) };
  });
  sessions = [...all('select id, parent_id from session'), ...v2Sessions];
}
/**
 * Thinking and writing of a reply OpenCode 2 wrote. It times the reasoning to the end of the
 * whole reply and nothing after it, so the time is shared out by the length of what was
 * written: the reasoning's share is thinking, the rest writing (only when there is text).
 */
const v2Spans = r => {
  const content = r.d.content ?? [];
  const end = r.d.time?.streamed;
  const thoughts = content.filter(i => i.type === 'reasoning' && i.time?.created != null);
  if (end == null || !thoughts.length) return null;
  const start = Math.min(...thoughts.map(i => i.time.created));
  if (!Number.isFinite(end) || end <= start) return null;
  const len = type => content.filter(i => i.type === type).reduce((n, i) => n + (type === 'tool' ? JSON.stringify(i.state?.input ?? {}).length : (i.text ?? '').length), 0);
  const all = len('reasoning') + len('text') + len('tool');
  const turn = all ? Math.round(start + ((end - start) * len('reasoning')) / all) : end;
  return { start, turn, thinking: turn - start, writing: content.some(i => i.type === 'text') ? end - turn : 0 };
};
const inRange = (t, from, to) => t >= from && t <= to;

readV2();
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
  if (hasV2) addV2(f, from, to, ids);
  return f;
}

/** The same figures from OpenCode 2's rows, added to those of 1.x. */
function addV2(f, from, to, ids) {
  const mine = r => !ids || ids.includes(r.session_id);
  const calls = v2Calls.filter(c => mine(c) && inRange(c.at, from, to));
  f.toolCalls += calls.length;
  f.toolErrors += calls.filter(c => c.error).length;
  f.compactions += v2Compactions.filter(r => mine(r) && inRange(r.time_created, from, to)).length;
  const active = (start, end) => Math.max(0, Math.min(end, to) - Math.max(start, from));
  for (const r of v2Replies.filter(mine)) f.activeMs += active(r.time_created, r.d.time?.completed ?? r.time_created);
  for (const r of v2Compactions.filter(mine)) f.activeMs += active(r.time_created, r.ended);
  // A compaction is a request too: OpenCode 2 writes what the summary cost on its row.
  for (const r of [...v2Replies, ...v2Compactions].filter(x => mine(x) && inRange(x.time_created, from, to) && sent(x.d) + (x.d.tokens?.output ?? 0) > 0)) {
    f.requests++;
    f.tokensSent += (r.d.tokens?.input ?? 0) + (r.d.tokens?.cache?.read ?? 0);
    f.tokensOutput += r.d.tokens?.output ?? 0;
    f.cost = Math.round((f.cost + (r.d.cost ?? 0)) * 1e4) / 1e4;
  }
  if (!ids) f.sessions += v2Sessions.filter(s => !s.parent_id && inRange(s.time_created, from, to)).length;
  const changed = v2Replies.filter(r => mine(r) && (r.d.snapshot?.files ?? []).length && inRange(r.d.time?.completed ?? r.time_updated, from, to));
  f.edits += changed.length;
  if (changed.length) {
    // Distinct files over both versions: counted together, not added.
    const before = all(`select json_extract(data,'$.files') f from part where json_extract(data,'$.type')='patch' and time_created between ? and ?${within(ids)}`, from, to, ...(ids ?? [])).flatMap(r => parse(r.f) ?? []);
    f.filesChanged = new Set([...before, ...changed.flatMap(r => r.d.snapshot.files)].map(fold)).size;
  }
  for (const r of v2Replies.filter(mine)) {
    const spans = v2Spans(r);
    if (spans && inRange(spans.start, from, to)) f.thinkingMs += spans.thinking;
    if (spans?.writing > 0 && inRange(spans.turn, from, to)) f.writingMs += spans.writing;
  }
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
    readV2();
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

const skippedLive = [];
for (const s of s30.sessions.slice(0, 5)) {
  const one30 = await view(`Stats, session "${s.title.slice(0, 30)}"`, `/api/stats?days=30&session=${s.id}`, family(s.id));
  // Two of the monitor's answers, a minute apart: a session working in between has more agent
  // time in the second. Compared only for a session that has stopped.
  if (s.lastAt >= startedAt - 10 * 60_000) skippedLive.push(s.title.slice(0, 30));
  else compare(`Stats, session "${s.title.slice(0, 30)}"`, 'its row in History = this view (agent time)', one30.totals.activeMs, s.activeMs);
}

// MCP rows
const prefixes = s30.mcp.map(m => m.name.replace(/[^a-zA-Z0-9_-]/g, '_') + '_');
const mcpCalls = [
  ...all(`select json_extract(data,'$.tool') tool, json_extract(data,'$.state.status') st from part where json_extract(data,'$.type')='tool' and ${START} between ? and ?`, s30.range.from, s30.range.to),
  ...v2Calls.filter(c => inRange(c.at, s30.range.from, s30.range.to)).map(c => ({ tool: c.tool, st: c.error ? 'error' : 'completed' })),
];
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
  // OpenCode 2: the first token is the start of the first thing written (text is not timed),
  // and the reply's own record says when the model stopped writing.
  for (const r of v2Replies.filter(x => `${x.d.model?.providerID}/${x.d.model?.id}` === top.model && inRange(x.time_created, s30.range.from, s30.range.to) && sent(x.d) + (x.d.tokens?.output ?? 0) > 0)) {
    msgs.push({ out: (r.d.tokens?.output ?? 0) + (r.d.tokens?.reasoning ?? 0), ft: r.d.content?.[0]?.time?.created ?? null, wr: r.d.time?.streamed ?? null });
  }
  let tokens = 0;
  let ms = 0;
  for (const r of msgs) if (r.ft != null && r.wr != null && r.out >= 20 && r.wr - r.ft >= 300) { tokens += r.out; ms += r.wr - r.ft; }
  compare('Model speed', `${top.model} writing (tok/s)`, ms ? Math.round((tokens / ms) * 10_000) / 10 : null, top.writeTps);
}

// Sessions on the Now tab
const state = await get('/api/state');
readV2();
for (const s of state.sessions.filter(x => !x.parentId).slice(0, 5)) {
  const area = `Now, "${s.title.slice(0, 30)}"`;
  const p = one(`select coalesce(sum(json_extract(data,'$.type')='tool'),0) t, coalesce(sum(json_extract(data,'$.type')='tool' and json_extract(data,'$.state.status')='error'),0) e, coalesce(sum(json_extract(data,'$.type')='compaction'),0) c from part where session_id = ?`, s.id);
  const calls = v2Calls.filter(c => c.session_id === s.id);
  compare(area, 'tool calls', p.t + calls.length, s.health.toolCalls);
  compare(area, 'failed', p.e + calls.filter(c => c.error).length, s.health.toolErrors);
  compare(area, 'compactions', p.c + v2Compactions.filter(r => r.session_id === s.id).length, s.health.compactions);
  const files = new Set([
    ...all(`select json_extract(data,'$.state.input.filePath') f from part where session_id = ? and json_extract(data,'$.tool') in ('edit','write','multiedit','apply_patch') and json_extract(data,'$.state.status')='completed'`, s.id).map(r => r.f).filter(Boolean),
    ...all(`select json_extract(data,'$.files') f from part where session_id = ? and json_extract(data,'$.type')='patch'`, s.id).flatMap(r => parse(r.f) ?? []),
    ...calls.filter(c => ['edit', 'write', 'multiedit', 'apply_patch'].includes(c.tool) && c.item.state?.status === 'completed').map(c => c.item.state.input?.path ?? c.item.state.input?.filePath).filter(Boolean),
    ...v2Replies.filter(r => r.session_id === s.id).flatMap(r => r.d.snapshot?.files ?? []),
  ].map(f => fold(underRoot(f, s.directory))));
  compare(area, 'files touched', files.size, s.work.files.count);
}

// This machine: models in use
const setup = await get('/api/setup');
readV2();
for (const m of setup.models) {
  const slash = m.id.indexOf('/');
  compare('This machine', `${m.id}: replies, 30 days`, one(`select count(*) n from message where json_extract(data,'$.role')='assistant' and json_extract(data,'$.providerID')=? and json_extract(data,'$.modelID')=? and time_created >= ?`, m.id.slice(0, slash), m.id.slice(slash + 1), Date.now() - 30 * 86_400_000).n
    + [...v2Replies, ...v2Compactions].filter(r => `${r.d.model?.providerID}/${r.d.model?.id}` === m.id && r.time_created >= Date.now() - 30 * 86_400_000).length, m.requests);
}

// Prompts that waited for you, from the log's own lines
const logPath = join(cfg.dataDir, 'log', 'opencode.log');
if (existsSync(logPath)) {
  const log = readFileSync(logPath, 'utf8');
  for (const d of [7, 30]) {
    const v = views[d];
    // OpenCode 2 logs no prompt. Its questions are the `question` calls themselves; its
    // permission prompts are known only while a monitor is running, and this one keeps none.
    const n = [...log.matchAll(/^timestamp=(\S+) level=\S+ run=\S+ message=asking id=(?:per|que)_/gm)].map(m => Date.parse(m[1])).filter(t => t >= v.range.from && t <= v.range.to).length
      + v2Calls.filter(c => c.tool === 'question' && inRange(c.at, v.range.from, v.range.to)).length;
    compare(`Stats, ${d} days`, 'prompts that waited for you', n, v.totals.prompts);
  }
}

// ---------------------------------------------------------------- report
const bad = rows.filter(r => !r.ok);
const written = lastWrite() > writtenAtStart;
// OpenCode wrote while this counted, and something differs: counted again, once, from the
// start, and only that count is reported. A difference that stays is not the moment's.
if (bad.length && written && !AGAIN) {
  console.log(`${bad.length} of ${rows.length} figures differed while OpenCode was writing (a session was working). Counting again...`);
  db.close();
  stop();
  const again = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: 'inherit', env: { ...process.env, OCM_VERIFY_AGAIN: '1' } });
  process.exitCode = again.status ?? 1;
} else {
  report();
}

function report() {
let area = '';
for (const r of rows) {
  if (r.area !== area) {
    area = r.area;
    console.log(`\n${area}`);
  }
  console.log(`  ${r.ok ? 'ok  ' : 'DIFF'} ${r.name.padEnd(46)} ${String(r.independent).padStart(14)} ${r.ok ? '' : `  monitor shows ${r.monitor}`}`);
}
const quoted = skippedLive.map(t => JSON.stringify(t)).join(', ');
if (skippedLive.length) console.log(`\nNot compared, as still working: its row in History against its own view, for ${quoted}.`);
console.log(`\n${rows.length - bad.length} of ${rows.length} figures agree with an independent count of this machine's data.`);
if (bad.length && written) console.log('OpenCode was writing while this counted, the second time too: run it again when no session is working. If a figure still differs then, it is a bug: please report it with this output (it holds counts only, no content).');
else if (bad.length) console.log('Figures that differ are a bug: please report them with this output (it holds counts only, no content).');
db.close();
// Not process.exit(): on Windows, leaving while a connection to the monitor is still closing
// ends Node with a failed assertion and an exit code of its own, whatever was found.
process.exitCode = bad.length ? 1 : 0;
stop();
}
