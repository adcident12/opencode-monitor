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
import { createRedactor } from './redact.mjs';
import { createStatsSource } from './stats-source.mjs';

const ALLOWED = new Set(['dataDir', 'config', 'sample']);

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
  const pending = cfg.history.enabled && !args.sample ? createPending({ file: join(dirname(resolve(ROOT, cfg.history.file)), 'prompts.jsonl'), retentionDays: cfg.history.retentionDays, readOnly: true }) : null;
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
  });
  // What the monitor recorded, read and never written: this process changes nothing.
  const configChanges = createConfigWatch({
    files: () => [],
    file: cfg.history.enabled && !args.sample ? join(dirname(resolve(ROOT, cfg.history.file)), 'config-changes.jsonl') : null,
    retentionDays: cfg.history.retentionDays,
    readOnly: true,
  });

  // The OpenCode that wrote the newest session: whose compaction rule applies.
  const opencodeVersion = () => db.recentSessions(0, 1)[0]?.version ?? null;
  const mcpDisconnected = () => {
    log.poll();
    return log.mcpDisconnected();
  };
  // Read again each time: the model is the setting changed most often.
  const currentModel = () => loadOpencodeConfig(cfg.opencodeConfigDir).model;
  const tools = buildTools({ stats, opencode, cfg, t: loadTranslator('en'), configChanges, redact, outputTokenMax, opencodeVersion, mcpDisconnected, currentModel });
  serve(createMcpServer({ tools, version: VERSION ?? '0' }), process.stdin, process.stdout);
  process.stdin.on('end', () => {
    db.close();
    process.exit(0);
  });
  const version = VERSION ? ` ${VERSION}` : '';
  console.error(`opencode-monitor MCP${version}: reading ${db.path} (read-only)`);
}
