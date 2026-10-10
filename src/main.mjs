// Wires everything together and serves the page on 127.0.0.1.
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { createConfigWatch, shownChanges } from './config-changes.mjs';
import { createDigest } from './digest.mjs';
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


/** Sends this week's summary now, from the real figures, and says how Discord answered. */
async function testDigest(cfg) {
  if (!cfg.notify.discord.webhookUrl) return 'no webhookUrl in config';
  if (!existsSync(join(cfg.dataDir, 'opencode.db'))) return 'no OpenCode database to summarise';
  const db = openDb(cfg.dataDir);
  try {
    const opencode = loadOpencodeConfig(cfg.opencodeConfigDir);
    const stats = createStatsSource({ db, log: createLogTail(join(cfg.dataDir, 'log', 'opencode.log')), cfg, redact: createRedactor(cfg.redact), mcpServers: opencode.mcp, projectMcp: createProjectMcp(), modelLimits: opencode.limits, modelReserves: opencode.reserves, compactionSettings: opencode.compaction, outputTokenMax: outputTokenMaxFrom() });
    const t = loadTranslator(cfg.lang);
    const notifier = createNotifier(cfg.notify, t, undefined, { quiet: true });
    createDigest({ cfg: cfg.notify, stats, send: notifier.send, t }).sendNow();
    const deadline = Date.now() + 15_000;
    while (notifier.recent()[0].discord === 'sending' && Date.now() < deadline) await new Promise(done => setTimeout(done, 200));
    const outcome = notifier.recent()[0].discord;
    return outcome === 'sending' ? 'no answer' : outcome;
  } finally {
    db.close();
  }
}

/** --help, --version, --autostart: answered without reading any settings. */
async function ranWithoutConfig(args) {
  if (args.help) {
    console.log(HELP);
  } else if (args.version) {
    console.log(VERSION ?? 'unknown');
  } else if (args.autostart) {
    const { autostart } = await import('./autostart.mjs');
    console.log(await autostart(args.autostart, { root: ROOT, args }));
  } else {
    return false;
  }
  return true;
}

async function runTestNotify(cfg) {
  for (const [channel, outcome] of await testNotify(cfg.notify, loadTranslator(cfg.lang))) console.log(`${channel}: ${outcome}`);
  if (process.platform === 'win32' && cfg.notify.desktop) {
    console.log('No pop-up on Windows? Check Do not disturb / Focus, and look in the notification centre (Win+N).');
  }
  if (cfg.notify.weekly.enabled) console.log(`weekly summary / Discord: ${await testDigest(cfg)}`);
}

function runDoctor(cfg) {
  // Works without a database too: saying that it is missing is the point.
  const found = existsSync(join(cfg.dataDir, 'opencode.db'));
  const doctorDb = found ? openDb(cfg.dataDir) : null;
  const oc = loadOpencodeConfig(cfg.opencodeConfigDir);
  const opencodeVersion = doctorDb?.recentSessions(0, 1)[0]?.version ?? null;
  console.log(formatSetupReport(buildSetupReport({ cfg, opencode: oc, db: doctorDb, opencodeVersion }), loadTranslator(cfg.lang), cfg.lang));
  doctorDb?.close();
}

function historyLine(cfg, sample) {
  if (!cfg.history.enabled) return 'off';
  if (sample) return 'in memory only';
  return `${resolve(ROOT, cfg.history.file)} (kept ${cfg.history.retentionDays} days)`;
}

function announce(cfg, db, sample) {
  const channels = [cfg.notify.desktop && 'desktop', cfg.notify.discord.webhookUrl && 'Discord'].filter(Boolean);
  const version = VERSION ? ` ${VERSION}` : '';
  const notifications = channels.length ? `${channels.join(' + ')} on ${cfg.notify.on.join(', ')}` : 'off';
  console.log(`opencode-monitor${version}: http://${HOST}:${cfg.port}`);
  console.log(`  reading ${db.path} (read-only)${sample ? ' — SAMPLE DATA' : ''}`);
  console.log(`  history: ${historyLine(cfg, sample)}`);
  console.log(`  notifications: ${notifications}`);
}

const JSON_TYPE = 'application/json; charset=utf-8';
const BASE_HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };

/** A file of the page, or 404. */
async function servePage(lookup, path, res) {
  const found = await lookup(path).catch(() => null);
  if (!found) {
    res.writeHead(404, BASE_HEADERS).end('Not found');
    return;
  }
  // Built assets have content hashes in their names and may be cached; the rest may not.
  const cache = path.startsWith('/_next/static/') ? 'public, max-age=31536000, immutable' : 'no-store';
  res.writeHead(200, {
    ...BASE_HEADERS,
    'cache-control': cache,
    'content-type': found.type,
    'referrer-policy': 'no-referrer',
    ...(found.csp ? { 'content-security-policy': found.csp } : {}),
  }).end(found.body);
}

/**
 * @returns {Promise<{port: number, close: () => Promise<void>}|undefined>} the running monitor,
 *   or nothing for the options that print something and are done
 */
export async function main(argv) {
  const args = parseArgs(argv);
  if (await ranWithoutConfig(args)) return;
  if (args.sample) {
    const { buildSample } = await import('../scripts/make-sample.mjs');
    args.dataDir = buildSample(join(ROOT, 'sample'));
    args.assumeRunning = true;
    args.noNotify = true;
  }

  const cfg = loadConfig(args);
  if (args.testNotify) return runTestNotify(cfg);
  if (args.sample) {
    // The sample directory carries its own fake OpenCode config; never mix in the real one.
    cfg.opencodeConfigDir = cfg.dataDir;
    cfg.services = [];
  }
  if (args.doctor) return runDoctor(cfg);

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

  const stats = createStatsSource({ db, log, cfg, redact: createRedactor(cfg.redact), mcpServers: opencode.mcp, projectMcp, modelLimits: opencode.limits, modelReserves: opencode.reserves, compactionSettings: opencode.compaction, outputTokenMax: outputTokenMaxFrom() });
  // Not for --sample: a summary of fake sessions has no business in a real channel.
  const digest = args.sample ? null : createDigest({ cfg: cfg.notify, stats, send: notify.send, t: loadTranslator(cfg.lang), stateFile: kept('weekly.json') });
  const historyCount = () => (cfg.history.enabled ? history.count : null);

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
    digest?.check(snap.now);
    if (!snap.stale) {
      notify(snap.sessions, snap.now);
      if (cfg.notify.environment && snap.environment?.checkedAt) notify.environment(snap.environment, snap.now);
      history.record(snap.sessions, snap.now);
    }
    latest = JSON.stringify({ ...snap, historyCount: historyCount(), build: lookup.buildId(), version: VERSION, opencodeTested: TESTED_OPENCODE, opencodeUntested: isUntestedOpencode(snap.opencodeVersion) === true });
    for (const res of clients) res.write(`data: ${latest}\n\n`);
  };
  tick();
  const timer = setInterval(tick, cfg.pollMs);

  const shown = { redact: createRedactor(cfg.redact), configDir: cfg.opencodeConfigDir };
  // What each address answers with, as JSON text. `unavailable`: said instead when it throws.
  const api = {
    '/api/state': { body: () => latest },
    '/api/stats': {
      body: query => JSON.stringify(stats(Number(query.get('days')), query.get('session'), query.get('split'))),
      unavailable: ['Stats failed', 'Stats are not available right now.'],
    },
    '/api/setup': {
      body: () => JSON.stringify(buildSetupReport({ cfg, opencode, db, opencodeVersion: monitor.opencodeVersion(), running: probe.running, historyCount: historyCount(), notifications: notify.recent() })),
      unavailable: ['Setup report failed', 'The setup report is not available right now.'],
    },
    '/api/history': {
      body: query => JSON.stringify(history.page({
        before: query.get('before'),
        after: query.get('after'),
        limit: query.get('limit') ?? 100,
        session: query.get('session'),
        attention: query.get('attention') === '1',
      })),
    },
    '/api/history/sessions': { body: () => JSON.stringify(history.sessions()) },
    '/api/config-changes': {
      body: query => {
        const days = Math.min(30, Math.max(1, Number(query.get('days')) || 30));
        return JSON.stringify(shownChanges(configWatch.list(Date.now() - days * 86_400_000), shown));
      },
    },
  };
  const answer = (route, query, res) => {
    let body;
    try {
      body = route.body(query);
    } catch (err) {
      if (!route.unavailable) throw err;
      console.warn(`${route.unavailable[0]}: ${err.code ?? err.message}`);
      res.writeHead(503, BASE_HEADERS).end(route.unavailable[1]);
      return;
    }
    res.writeHead(200, { ...BASE_HEADERS, 'content-type': JSON_TYPE }).end(body);
  };

  const allowedHosts = new Set([`127.0.0.1:${cfg.port}`, `localhost:${cfg.port}`]);
  const server = createServer(async (req, res) => {
    // Refuse requests that reached us under another name (DNS rebinding from a web page).
    if (!allowedHosts.has(req.headers.host) || req.method !== 'GET') {
      res.writeHead(403).end();
      return;
    }
    const { pathname: path, searchParams: query } = new URL(req.url, `http://${HOST}`);
    if (path === '/api/events') {
      res.writeHead(200, { ...BASE_HEADERS, 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive' });
      res.write(`data: ${latest}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
    } else if (Object.hasOwn(api, path)) {
      answer(api[path], query, res);
    } else {
      await servePage(lookup, path, res);
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', err => reject(err.code === 'EADDRINUSE'
      ? new UserError(`Port ${cfg.port} is already in use. Pass --port <n> or set "port" in config.json.`)
      : err));
    server.listen(cfg.port, HOST, resolve);
  });
  announce(cfg, db, args.sample);

  return {
    port: cfg.port,
    /** Stops polling, ends open page connections, and lets go of the port and the database. */
    close: async () => {
      clearInterval(timer);
      for (const res of clients) res.end();
      server.closeAllConnections();
      await new Promise(done => server.close(done));
      db.close();
    },
  };
}
