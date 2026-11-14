// OpenCode Central, hub mode (`node server.mjs --central`). Receives the machines' sealed batches at POST /ingest
// (src/central/ingest.mjs) into one OpenCode-shaped database each (store.mjs), and runs the unchanged monitor on
// every one of them with stand-ins for what only the machine could see (facts.mjs). The page and the API answer for
// the machine picked — ?machine=<name>, else the ocm_machine cookie, else the first — through stripContent, and
// there is no replay, no setup report and no /mcp here (phase 1).
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { ROOT, VERSION } from '../config.mjs';
import { openDb } from '../db.mjs';
import { createMonitor } from '../monitor.mjs';
import { createStatsSource } from '../stats-source.mjs';
import { createTasksSource, TASK_DAYS } from '../tasks.mjs';
import { createCostSource } from '../costs.mjs';
import { createHistory } from '../history.mjs';
import { createOvernight } from '../overnight.mjs';
import { createStatic } from '../static.mjs';
import { createAccess, loadAccessKey } from '../access.mjs';
import { clip, createRedactor } from '../redact.mjs';
import { admit, answerRoute, servePage, accessKeyFile, BASE_HEADERS, JSON_TYPE, HOST, EVERY_INTERFACE } from '../main.mjs';
import { createCentralStore } from './store.mjs';
import { createRemoteSources } from './facts.mjs';
import { initHubKeys, readTokens } from './tokens.mjs';
import { handleIngest } from './ingest.mjs';
import { stripContent } from './view.mjs';
import { admitVia } from './proxy.mjs';
import { createInfluxExport, toLines, stateLine, versionLine } from './influx.mjs';

const PRUNE_EVERY = 6 * 3_600_000;

function cookieMachine(req) {
  const m = /(?:^|;\s*)ocm_machine=([a-z0-9-]{1,32})(?:;|$)/.exec(String(req.headers.cookie ?? ''));
  return m ? m[1] : null;
}

/**
 * @param {object} cfg  loadConfig() output
 * @param {{ onApplied?: (batch: object, machine: string) => void }} [opts]  e.g. the InfluxDB export (Task 9)
 * @returns {Promise<{ port: number, close: () => Promise<void> }>}
 */
export async function startHub(cfg, { onApplied = () => {} } = {}) {
  const dir = resolve(ROOT, cfg.central.dir);
  const keys = initHubKeys(dir);
  const store = createCentralStore({ dir: join(dir, 'machines') });
  // The key figures to the home's InfluxDB (spec 5.3.1), when central.influx is set.
  const influx = cfg.central.influx?.url ? createInfluxExport(cfg.central.influx) : null;
  const folder = dirPath => (typeof dirPath === 'string' ? dirPath.split('/').filter(Boolean).pop() ?? null : null);
  const lookupFor = (machine, batch) => {
    const sessionsIn = new Map([...(batch.rows?.session ?? []), ...(batch.rows?.session_v2 ?? [])].map(s => [s.id, s.directory]));
    const messagesIn = new Map((batch.rows?.message ?? []).map(m => [m.id, m.data]));
    return {
      projectOf: id => folder(sessionsIn.get(id) ?? store.row(machine, 'session', id)?.directory ?? store.row(machine, 'session_v2', id)?.directory),
      modelOf: id => {
        try { const d = JSON.parse(messagesIn.get(id) ?? store.row(machine, 'message', id)?.data ?? '{}'); return { providerID: d.providerID, modelID: d.modelID }; } catch { return null; }
      },
    };
  };
  const applied = (batch, machine) => {
    if (influx) influx.write(toLines(batch, machine, lookupFor(machine, batch)));
    onApplied(batch, machine);
  };
  const redact = createRedactor(cfg.redact);
  const show = (text, max) => clip(redact(String(text ?? '')), max);
  const contexts = new Map(); // machine -> its monitor and sources

  function contextFor(name) {
    let c = contexts.get(name);
    if (c) return c;
    const db = openDb(store.dataDirOf(name));
    const { log, probe, pending, git } = createRemoteSources(() => store.facts(name));
    const live = new Map();
    const history = createHistory({ ...cfg.history, file: join(store.dataDirOf(name), 'history.jsonl') });
    const tasks = createTasksSource({ db, show, liveState: id => live.get(id) ?? null });
    c = {
      db, live, history, tasks, log, probe, pending, git,
      costs: createCostSource({ db, cfg, show }),
      overnight: createOvernight({ cfg, history, tasks }),
      latest: '{}',
      clients: new Set(),
      settingsKey: null,
    };
    useSettings(c, store.facts(name));
    contexts.set(name, c);
    return c;
  }

  /** The monitor and stats of a machine, with the model limits and compaction settings its OpenCode uses. */
  function useSettings(c, facts) {
    const o = facts?.opencode ?? null;
    const key = JSON.stringify(o);
    if (key === c.settingsKey) return;
    c.settingsKey = key;
    const settings = {
      modelLimits: new Map(o?.limits ?? []),
      modelReserves: new Map(o?.reserves ?? []),
      compactionSettings: o?.compaction ?? {},
      outputTokenMax: o?.outputTokenMax ?? null,
    };
    c.monitor = createMonitor({ db: c.db, log: c.log, cfg, redact, probe: c.probe, git: c.git, pending: c.pending, ...settings });
    c.stats = createStatsSource({ db: c.db, log: c.log, cfg, redact, ...settings });
  }

  const names = () => store.machines().map(m => m.name);

  /** Session state changes and a new OpenCode version, as points (a state's length is known when it ends). */
  function influxChanges(name, c, snap) {
    const lines = [];
    c.since ??= new Map();
    for (const s of snap.sessions) {
      const before = c.live.get(s.id);
      if (before && before !== s.state) lines.push(stateLine(name, folder(s.directory), before, s.state, (snap.now - (c.since.get(s.id) ?? snap.now)) / 1000, snap.now));
      if (before !== s.state) c.since.set(s.id, snap.now);
    }
    const v = store.facts(name)?.opencodeVersion ?? null;
    if (v && v !== c.version) { lines.push(versionLine(name, v, snap.now)); c.version = v; }
    if (lines.length) influx.write(lines);
  }

  function tick() {
    const all = names();
    for (const name of all) {
      try {
        const c = contextFor(name);
        useSettings(c, store.facts(name));
        const snap = c.monitor();
        if (influx) influxChanges(name, c, snap);
        c.live = new Map(snap.sessions.map(s => [s.id, s.state]));
        if (!snap.stale) c.history.record(snap.sessions, snap.now);
        c.latest = JSON.stringify(stripContent('state', { ...snap, historyCount: c.history.count, version: VERSION, central: { machine: name, machines: all } }));
        for (const res of c.clients) res.write(`data: ${c.latest}\n\n`);
      } catch (err) {
        console.warn(`central: ${name}: ${err?.message ?? err}`);
      }
    }
  }

  const json = body => JSON.stringify(body);
  const routes = c => ({
    '/api/state': { body: () => c.latest },
    '/api/stats': { body: q => json(stripContent('stats', c.stats(Number(q.get('days')), q.get('session'), q.get('split')))), unavailable: ['Stats failed', 'Stats are not available right now.'] },
    '/api/history': { body: q => json(stripContent('history', c.history.page({ before: q.get('before'), after: q.get('after'), limit: q.get('limit') ?? 100, session: q.get('session'), attention: q.get('attention') === '1' }))) },
    '/api/history/sessions': { body: () => json(stripContent('history', c.history.sessions())) },
    '/api/tasks': { body: q => json(stripContent('tasks', c.tasks(TASK_DAYS.includes(Number(q.get('days'))) ? Number(q.get('days')) : 7))), unavailable: ['Tasks failed', 'The list of tasks is not available right now.'] },
    '/api/overnight': { body: () => json(stripContent('overnight', c.overnight.report())), unavailable: ['Overnight report failed', 'The overnight report is not available right now.'] },
    '/api/costs': { body: () => json(stripContent('costs', c.costs())), unavailable: ['Cost report failed', 'The cost report is not available right now.'] },
    '/api/config-changes': { body: () => '[]' },
  });

  const lookup = createStatic(ROOT);
  let access = null;
  const server = createServer(async (req, res) => {
    const path = String(req.url ?? '/').split('?')[0];
    if (path === '/health' && req.method === 'GET') {
      res.writeHead(200, { ...BASE_HEADERS, 'content-type': JSON_TYPE }).end('{"ok":true}');
      return;
    }
    if (path === '/ingest') {
      await handleIngest(req, res, { store, tokens: () => readTokens(dir), privateKey: keys.privateKey, onApplied: applied });
      return;
    }
    // Behind the login proxy (central.proxy): its secret header stands in for the access key.
    const admitted = admitVia(req, res, access, cfg.central.proxy ?? null, admit);
    if (!admitted) return;
    const { toMcp, url } = admitted;
    const { pathname, searchParams: query } = url;
    if (toMcp) { res.writeHead(404, BASE_HEADERS).end('Not here'); return; }
    if (pathname === '/api/machines') {
      const list = store.machines().map(m => ({ name: m.name, lastAt: m.lastAt, opencodeVersion: m.facts?.opencodeVersion ?? null, running: m.facts?.running ?? null }));
      res.writeHead(200, { ...BASE_HEADERS, 'content-type': JSON_TYPE }).end(json(list));
      return;
    }
    if (pathname.startsWith('/api/')) {
      const all = names();
      const name = query.get('machine') ?? cookieMachine(req) ?? all[0];
      if (!name || !all.includes(name)) { res.writeHead(404, BASE_HEADERS).end('No such machine'); return; }
      const c = contextFor(name);
      if (pathname === '/api/events') {
        res.writeHead(200, { ...BASE_HEADERS, 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive' });
        res.write(`data: ${c.latest}\n\n`);
        c.clients.add(res);
        req.on('close', () => c.clients.delete(res));
        return;
      }
      const r = routes(c);
      if (Object.hasOwn(r, pathname)) answerRoute(r[pathname], query, res);
      else res.writeHead(404, BASE_HEADERS).end('Not here');
      return;
    }
    await servePage(lookup, pathname, res);
  });

  await new Promise((done, fail) => { server.once('error', fail); server.listen(cfg.port, cfg.lan ? EVERY_INTERFACE : HOST, done); });
  const port = server.address().port;
  access = createAccess({ lan: cfg.lan, port, key: cfg.lan ? loadAccessKey(accessKeyFile(cfg)) : undefined });
  // The names the hub is reached by from outside its container (the host's address, later its public name).
  for (const h of cfg.central.hosts ?? []) access.hosts.add(String(h).toLowerCase());

  tick();
  const timer = setInterval(tick, cfg.pollMs);
  const pruner = setInterval(() => { try { store.prune(); } catch (err) { console.warn(`central: prune: ${err.message}`); } }, PRUNE_EVERY);
  console.log(`opencode-monitor central: listening on port ${port}, machines: ${names().join(', ') || 'none yet'}`);

  return {
    port,
    close: async () => {
      clearInterval(timer);
      clearInterval(pruner);
      for (const c of contexts.values()) { for (const res of c.clients) res.end(); c.db.close?.(); }
      server.closeAllConnections?.();
      await new Promise(r => server.close(r));
      store.close();
    },
  };
}
