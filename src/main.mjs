// Wires everything together and serves the page on 127.0.0.1.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHistory } from './history.mjs';
import { ROOT, HELP, UserError, parseArgs, loadConfig } from './config.mjs';
import { openDb } from './db.mjs';
import { createLogTail } from './logtail.mjs';
import { createRedactor } from './redact.mjs';
import { loadOpencodeConfig } from './opencode-config.mjs';
import { createEnvironment } from './environment.mjs';
import { createGitProbe } from './git.mjs';
import { createProcessProbe } from './process.mjs';
import { createMonitor } from './monitor.mjs';
import { createNotifier } from './notify.mjs';
import { loadTranslator } from './format.mjs';

const HOST = '127.0.0.1'; // Not configurable on purpose: the page shows what your agent is doing.

const STATIC = {
  '/': ['public/index.html', 'text/html; charset=utf-8'],
  '/app.js': ['public/app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['public/style.css', 'text/css; charset=utf-8'],
};

export async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(HELP);
    return;
  }
  if (args.sample) {
    const { buildSample } = await import('../scripts/make-sample.mjs');
    args.dataDir = buildSample(join(ROOT, 'sample'));
    args.assumeRunning = true;
    args.noNotify = true;
  }

  const cfg = loadConfig(args);
  if (args.sample) {
    // The sample directory carries its own fake OpenCode config; never mix in the real one.
    cfg.opencodeConfigDir = cfg.dataDir;
    cfg.services = [];
  }
  const db = openDb(cfg.dataDir);
  const log = createLogTail(join(cfg.dataDir, 'log', 'opencode.log'));
  const probe = createProcessProbe(cfg.processNames, { enabled: cfg.processCheck });
  const opencode = loadOpencodeConfig(cfg.opencodeConfigDir, args.sample ? { XDG_CACHE_HOME: cfg.dataDir } : process.env);
  const environment = createEnvironment({ cfg, opencode, log, probe });
  const git = createGitProbe({ enabled: cfg.work.git });
  const monitor = createMonitor({
    db, log, cfg, probe, environment, git,
    redact: createRedactor(cfg.redact),
    modelLimits: opencode.limits,
    mcpNames: opencode.mcp.map(server => server.name),
  });
  const notify = createNotifier(cfg.notify, loadTranslator(cfg.lang));
  // Sample runs keep their history in memory so fake sessions never land in the real file.
  const history = createHistory({ ...cfg.history, file: args.sample ? null : resolve(ROOT, cfg.history.file) });

  let latest = '{}';
  const clients = new Set();
  await probe.refresh();
  const tick = () => {
    // Background checks; each keeps its own interval and the snapshot uses the latest results.
    probe.refresh();
    environment.refresh();
    git.refresh(monitor.directories());
    const snap = monitor();
    if (!snap.stale) {
      notify(snap.sessions, snap.now);
      if (cfg.notify.environment && snap.environment?.checkedAt) notify.environment(snap.environment, snap.now);
      history.record(snap.sessions, snap.now);
    }
    latest = JSON.stringify({ ...snap, historyCount: cfg.history.enabled ? history.count : null });
    for (const res of clients) res.write(`data: ${latest}\n\n`);
  };
  tick();
  setInterval(tick, cfg.pollMs);

  const allowedHosts = new Set([`127.0.0.1:${cfg.port}`, `localhost:${cfg.port}`]);
  const server = createServer(async (req, res) => {
    // Refuse requests that reached us under another name (DNS rebinding from a web page).
    if (!allowedHosts.has(req.headers.host) || req.method !== 'GET') {
      res.writeHead(403).end();
      return;
    }
    const path = new URL(req.url, `http://${HOST}`).pathname;
    const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };

    if (path === '/api/state') {
      res.writeHead(200, { ...headers, 'content-type': 'application/json; charset=utf-8' }).end(latest);
    } else if (path === '/api/events') {
      res.writeHead(200, { ...headers, 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive' });
      res.write(`data: ${latest}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
    } else if (path === '/api/history') {
      res.writeHead(200, { ...headers, 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(history.list()));
    } else if (path === '/favicon.ico') {
      res.writeHead(204, headers).end();
    } else {
      const i18n = /^\/i18n\/([a-z]{2,3})\.json$/.exec(path);
      const [file, type] = i18n ? [`i18n/${i18n[1]}.json`, 'application/json; charset=utf-8'] : STATIC[path] ?? [];
      try {
        if (!file) throw new Error('not found');
        const body = await readFile(join(ROOT, file));
        res.writeHead(200, { ...headers, 'content-type': type, 'content-security-policy': "default-src 'self'" }).end(body);
      } catch {
        res.writeHead(404, headers).end('Not found');
      }
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', err => reject(err.code === 'EADDRINUSE'
      ? new UserError(`Port ${cfg.port} is already in use. Pass --port <n> or set "port" in config.json.`)
      : err));
    server.listen(cfg.port, HOST, resolve);
  });

  console.log(`opencode-monitor: http://${HOST}:${cfg.port}`);
  console.log(`  reading ${db.path} (read-only)${args.sample ? ' — SAMPLE DATA' : ''}`);
  const channels = [cfg.notify.desktop && 'desktop', cfg.notify.discord.webhookUrl && 'Discord'].filter(Boolean);
  console.log(`  history: ${!cfg.history.enabled ? 'off' : args.sample ? 'in memory only' : `${resolve(ROOT, cfg.history.file)} (kept ${cfg.history.retentionDays} days)`}`);
  console.log(`  notifications: ${channels.length ? `${channels.join(' + ')} on ${cfg.notify.on.join(', ')}` : 'off'}`);
}
