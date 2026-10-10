// Wires everything together and serves the page on 127.0.0.1.
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createConfigWatch } from './config-changes.mjs';
import { createStatic } from './static.mjs';
import { createStatsSource } from './stats-source.mjs';
import { createHistory } from './history.mjs';
import { ROOT, HELP, VERSION, TESTED_OPENCODE, isUntestedOpencode, UserError, parseArgs, loadConfig } from './config.mjs';
import { openDb } from './db.mjs';
import { createLogTail } from './logtail.mjs';
import { createRedactor } from './redact.mjs';
import { configFiles, createProjectMcp, loadOpencodeConfig, outputTokenMaxFrom } from './opencode-config.mjs';
import { createEnvironment } from './environment.mjs';
import { createGitProbe } from './git.mjs';
import { createLeftoverProbe } from './leftovers.mjs';
import { createProcessProbe } from './process.mjs';
import { createMonitor } from './monitor.mjs';
import { createNotifier, testNotify } from './notify.mjs';
import { loadTranslator } from './format.mjs';
import { existsSync } from 'node:fs';
import { buildSetupReport, formatSetupReport } from './setup.mjs';

const HOST = '127.0.0.1'; // Not configurable on purpose: the page shows what your agent is doing.


export async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(HELP);
    return;
  }
  if (args.version) {
    console.log(VERSION ?? 'unknown');
    return;
  }
  if (args.autostart) {
    const { autostart } = await import('./autostart.mjs');
    console.log(await autostart(args.autostart, { root: ROOT, args }));
    return;
  }
  if (args.sample) {
    const { buildSample } = await import('../scripts/make-sample.mjs');
    args.dataDir = buildSample(join(ROOT, 'sample'));
    args.assumeRunning = true;
    args.noNotify = true;
  }

  const cfg = loadConfig(args);
  if (args.testNotify) {
    for (const [channel, outcome] of await testNotify(cfg.notify, loadTranslator(cfg.lang))) console.log(`${channel}: ${outcome}`);
    if (process.platform === 'win32' && cfg.notify.desktop) {
      console.log('No pop-up on Windows? Check Do not disturb / Focus, and look in the notification centre (Win+N).');
    }
    return;
  }
  if (args.sample) {
    // The sample directory carries its own fake OpenCode config; never mix in the real one.
    cfg.opencodeConfigDir = cfg.dataDir;
    cfg.services = [];
  }
  if (args.doctor) {
    // Works without a database too: saying that it is missing is the point.
    const found = existsSync(join(cfg.dataDir, 'opencode.db'));
    const doctorDb = found ? openDb(cfg.dataDir) : null;
    const oc = loadOpencodeConfig(cfg.opencodeConfigDir);
    const opencodeVersion = doctorDb?.recentSessions(0, 1)[0]?.version ?? null;
    console.log(formatSetupReport(buildSetupReport({ cfg, opencode: oc, db: doctorDb, opencodeVersion }), loadTranslator(cfg.lang)));
    doctorDb?.close();
    return;
  }
  const db = openDb(cfg.dataDir);
  const log = createLogTail(join(cfg.dataDir, 'log', 'opencode.log'));
  const probe = createProcessProbe(cfg.processNames, { enabled: cfg.processCheck });
  const opencode = loadOpencodeConfig(cfg.opencodeConfigDir, args.sample ? { XDG_CACHE_HOME: cfg.dataDir } : process.env);
  const environment = createEnvironment({ cfg, opencode, log, probe });
  // Off for --sample: fake sessions name directories that may exist on this machine.
  const projectMcp = args.sample ? null : createProjectMcp();
  const git = createGitProbe({ enabled: cfg.work.git });
  // Off for --sample: fake sessions must never be matched against real processes.
  const leftovers = createLeftoverProbe({ enabled: cfg.work.processes && !args.sample, ignoreNames: cfg.processNames });
  const monitor = createMonitor({
    db, log, cfg, probe, environment, git, leftovers, projectMcp,
    redact: createRedactor(cfg.redact),
    modelLimits: opencode.limits,
    modelReserves: opencode.reserves,
    compactionSettings: opencode.compaction,
    outputTokenMax: outputTokenMaxFrom(),
    mcpNames: opencode.mcp.map(server => server.name),
  });
  const notify = createNotifier(cfg.notify, loadTranslator(cfg.lang));
  // Sample runs keep their history in memory so fake sessions never land in the real file.
  const history = createHistory({ ...cfg.history, file: args.sample ? null : resolve(ROOT, cfg.history.file) });
  // Kept beside the history and with it: off with it, in memory for --sample (whose config is fake).
  const keep = cfg.history.enabled && !args.sample;
  const kept = name => (keep ? join(dirname(resolve(ROOT, cfg.history.file)), name) : null);
  const configWatch = createConfigWatch({
    files: () => (args.sample ? [] : configFiles(cfg.opencodeConfigDir, monitor.directories())),
    file: kept('config-changes.jsonl'),
    seenFile: kept('config-seen.json'),
    retentionDays: cfg.history.retentionDays,
  });

  let latest = '{}';
  const clients = new Set();
  await probe.refresh();
  const lookup = createStatic(ROOT);
  const tick = () => {
    // Background checks; each keeps its own interval and the snapshot uses the latest results.
    probe.refresh();
    environment.refresh();
    git.refresh(monitor.directories());
    leftovers.refresh(monitor.backgroundCalls());
    const snap = monitor();
    configWatch.check(snap.now);
    if (!snap.stale) {
      notify(snap.sessions, snap.now);
      if (cfg.notify.environment && snap.environment?.checkedAt) notify.environment(snap.environment, snap.now);
      history.record(snap.sessions, snap.now);
    }
    latest = JSON.stringify({ ...snap, historyCount: cfg.history.enabled ? history.count : null, build: lookup.buildId(), version: VERSION, opencodeTested: TESTED_OPENCODE, opencodeUntested: isUntestedOpencode(snap.opencodeVersion) === true });
    for (const res of clients) res.write(`data: ${latest}\n\n`);
  };
  tick();
  setInterval(tick, cfg.pollMs);

  const stats = createStatsSource({ db, log, cfg, redact: createRedactor(cfg.redact), mcpServers: opencode.mcp, projectMcp, modelLimits: opencode.limits, modelReserves: opencode.reserves, compactionSettings: opencode.compaction, outputTokenMax: outputTokenMaxFrom() });
  // The file named from home, and everything passed through the redactor like the rest of the page.
  const redact = createRedactor(cfg.redact);
  const home = homedir();
  const shownChanges = list => list.map(e => ({
    ...e,
    file: redact(e.file.startsWith(home) ? `~${e.file.slice(home.length)}`.replaceAll('\\', '/') : e.file.replaceAll('\\', '/')),
    global: e.file.startsWith(resolve(cfg.opencodeConfigDir)),
    changes: e.changes.map(c => ({ ...c, path: redact(c.path), ...(typeof c.from === 'string' ? { from: redact(c.from) } : {}), ...(typeof c.to === 'string' ? { to: redact(c.to) } : {}) })),
  }));
  const allowedHosts =new Set([`127.0.0.1:${cfg.port}`, `localhost:${cfg.port}`]);
  const server = createServer(async (req, res) => {
    // Refuse requests that reached us under another name (DNS rebinding from a web page).
    if (!allowedHosts.has(req.headers.host) || req.method !== 'GET') {
      res.writeHead(403).end();
      return;
    }
    const { pathname: path, searchParams: query } = new URL(req.url, `http://${HOST}`);
    const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };

    if (path === '/api/state') {
      res.writeHead(200, { ...headers, 'content-type': 'application/json; charset=utf-8' }).end(latest);
    } else if (path === '/api/events') {
      res.writeHead(200, { ...headers, 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive' });
      res.write(`data: ${latest}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
    } else if (path === '/api/stats') {
      try {
        res.writeHead(200, { ...headers, 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(stats(Number(query.get('days')), query.get('session'), query.get('split'))));
      } catch (err) {
        console.warn(`Stats failed: ${err.code ?? err.message}`);
        res.writeHead(503, headers).end('Stats are not available right now.');
      }
    } else if (path === '/api/setup') {
      try {
        const report = buildSetupReport({ cfg, opencode, db, opencodeVersion: monitor.opencodeVersion(), running: probe.running, historyCount: cfg.history.enabled ? history.count : null, notifications: notify.recent() });
        res.writeHead(200, { ...headers, 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(report));
      } catch (err) {
        console.warn(`Setup report failed: ${err.code ?? err.message}`);
        res.writeHead(503, headers).end('The setup report is not available right now.');
      }
    } else if (path === '/api/history') {
      res.writeHead(200, { ...headers, 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(history.page({
        before: query.get('before'),
        after: query.get('after'),
        limit: query.get('limit') ?? 100,
        session: query.get('session'),
        attention: query.get('attention') === '1',
      })));
    } else if (path === '/api/config-changes') {
      const days = Math.min(30, Math.max(1, Number(query.get('days')) || 30));
      res.writeHead(200, { ...headers, 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(shownChanges(configWatch.list(Date.now() - days * 86_400_000))));
    } else if (path === '/api/history/sessions') {
      res.writeHead(200, { ...headers, 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(history.sessions()));
    } else {
      const found = await lookup(path).catch(() => null);
      if (!found) {
        res.writeHead(404, headers).end('Not found');
        return;
      }
      // Built assets have content hashes in their names and may be cached; the rest may not.
      const cache = path.startsWith('/_next/static/') ? 'public, max-age=31536000, immutable' : 'no-store';
      res.writeHead(200, {
        ...headers,
        'cache-control': cache,
        'content-type': found.type,
        'referrer-policy': 'no-referrer',
        ...(found.csp ? { 'content-security-policy': found.csp } : {}),
      }).end(found.body);
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', err => reject(err.code === 'EADDRINUSE'
      ? new UserError(`Port ${cfg.port} is already in use. Pass --port <n> or set "port" in config.json.`)
      : err));
    server.listen(cfg.port, HOST, resolve);
  });

  console.log(`opencode-monitor${VERSION ? ` ${VERSION}` : ''}: http://${HOST}:${cfg.port}`);
  console.log(`  reading ${db.path} (read-only)${args.sample ? ' — SAMPLE DATA' : ''}`);
  const channels = [cfg.notify.desktop && 'desktop', cfg.notify.discord.webhookUrl && 'Discord'].filter(Boolean);
  console.log(`  history: ${!cfg.history.enabled ? 'off' : args.sample ? 'in memory only' : `${resolve(ROOT, cfg.history.file)} (kept ${cfg.history.retentionDays} days)`}`);
  console.log(`  notifications: ${channels.length ? `${channels.join(' + ')} on ${cfg.notify.on.join(', ')}` : 'off'}`);
}
