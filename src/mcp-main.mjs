// Wires the MCP server to OpenCode's data. The same readers the page uses, so an assistant
// is told the figures the page shows.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { ROOT, VERSION, UserError, parseArgs, loadConfig } from './config.mjs';
import { createConfigWatch } from './config-changes.mjs';
import { openDb } from './db.mjs';
import { loadTranslator } from './format.mjs';
import { createLogTail } from './logtail.mjs';
import { createPending, withPending } from './pending.mjs';
import { buildTools, createMcpServer, serve } from './mcp-server.mjs';
import { createProjectMcp, loadOpencodeConfig, outputTokenMaxFrom } from './opencode-config.mjs';
import { clip, createRedactor } from './redact.mjs';
import { createStatsSource } from './stats-source.mjs';
import { createTasksSource } from './tasks.mjs';
import { createHistory } from './history.mjs';
import { createOvernight } from './overnight.mjs';
import { createServedLog } from './served.mjs';
import { createReadLog } from './reads.mjs';
import { createEnvironment } from './environment.mjs';

const ALLOWED = new Set(['dataDir', 'config', 'sample']);

/**
 * The monitor's own files, beside the history, that this process reads and never writes:
 * none when the history is off, or for --sample, whose sessions are not the user's.
 */
function keptFiles(cfg, args) {
  const keep = cfg.history.enabled && !args.sample;
  return {
    history: keep ? resolve(ROOT, cfg.history.file) : null,
    beside: name => (keep ? join(dirname(resolve(ROOT, cfg.history.file)), name) : null),
  };
}

export async function mcpMain(argv) {
  const args = parseArgs(argv);
  for (const key of Object.keys(args)) if (!ALLOWED.has(key)) throw new UserError('mcp.mjs takes only --data-dir, --config and --sample.');
  if (args.sample) {
    const { buildSample } = await import('../scripts/make-sample.mjs');
    // Its own copy: a monitor started with --sample may be rebuilding the shared one.
    args.dataDir = buildSample(mkdtempSync(join(tmpdir(), 'ocm-mcp-sample-')));
  }
  const cfg = loadConfig(args);
  if (args.sample) cfg.opencodeConfigDir = cfg.dataDir;

  const db = openDb(cfg.dataDir);
  // The prompts of OpenCode 2 the monitor recorded: read, never asked for from here.
  const kept = keptFiles(cfg, args);
  const pending = kept.history ? createPending({ file: kept.beside('prompts.jsonl'), retentionDays: cfg.history.retentionDays, readOnly: true }) : null;
  const log = withPending(createLogTail(join(cfg.dataDir, 'log', 'opencode.log')), pending);
  const opencode = loadOpencodeConfig(cfg.opencodeConfigDir, args.sample ? { XDG_CACHE_HOME: cfg.dataDir } : process.env);
  const redact = createRedactor(cfg.redact);
  const outputTokenMax = outputTokenMaxFrom();
  const stats = createStatsSource({
    db, log, cfg, redact,
    mcpServers: opencode.mcp,
    projectMcp: args.sample ? null : createProjectMcp(),
    modelLimits: opencode.limits,
    modelReserves: opencode.reserves,
    compactionSettings: opencode.compaction,
    outputTokenMax,
    permissionRules: () => loadOpencodeConfig(cfg.opencodeConfigDir).permissions,
    // Read when a figure is asked for, after configChanges below is made.
    configChangedAt: since => configChanges.list(since).map(c => c.t),
    servedAt: (provider, t) => served.servedAt(provider, t),
    longReads: (from, to, inScope) => reads.between(from, to, inScope),
  });
  const reads = createReadLog({ file: kept.beside('reads.jsonl'), retentionDays: cfg.history.retentionDays, readOnly: true });
  // Which model each server had loaded, as the monitor recorded it: read, never written.
  const served = createServedLog({ file: kept.beside('served.jsonl'), retentionDays: cfg.history.retentionDays, readOnly: true });
  // What the monitor recorded, read and never written: this process changes nothing.
  const configChanges = createConfigWatch({
    files: () => [],
    file: kept.beside('config-changes.jsonl'),
    retentionDays: cfg.history.retentionDays,
    readOnly: true,
  });

  // The OpenCode in use now, whose compaction rule applies: as its log says, or else the
  // version that created the newest session.
  const opencodeVersion = () => {
    log.poll();
    return log.opencodeVersion() ?? db.recentSessions(0, 1)[0]?.version ?? null;
  };
  const mcpDisconnected = () => {
    log.poll();
    return log.mcpDisconnected();
  };
  // Read again each time: the model is the setting changed most often.
  const currentModel = () => loadOpencodeConfig(cfg.opencodeConfigDir).model;
  const tasks = createTasksSource({ db, show: (text, max) => clip(redact(String(text ?? '')), max) });
  // The monitor's record of each change of state, read and never written.
  const history = createHistory({ ...cfg.history, file: kept.history, readOnly: true });
  const overnight = createOvernight({ cfg, history, tasks });
  // Each model server's own settings, read now and then in the background: the tools answer
  // at once from what was last read. Not for --sample: its sessions are fake, the servers real.
  const environment = args.sample ? null : createEnvironment({ cfg, opencode, log, probe: { running: null } });
  // The first reading before the first answer: a tool asked at once must not say "not read".
  await environment?.refresh();
  if (environment) setInterval(() => environment.refresh(), 60_000).unref();
  const modelServers = () => environment?.view(new Map()).models ?? [];
  const tools = buildTools({ stats, opencode, cfg, t: loadTranslator('en'), configChanges, redact, outputTokenMax, opencodeVersion, mcpDisconnected, currentModel, tasks, overnight, modelServers });
  serve(createMcpServer({ tools, version: VERSION ?? '0' }), process.stdin, process.stdout);
  process.stdin.on('end', () => {
    db.close();
    process.exit(0);
  });
  const version = VERSION ? ` ${VERSION}` : '';
  console.error(`opencode-monitor MCP${version}: reading ${db.path} (read-only)`);
}
