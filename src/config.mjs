// Settings: defaults <- config.json <- environment <- command line.
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export class UserError extends Error {
  userFacing = true;
}

export const DEFAULTS = {
  port: 4317,
  pollMs: 2000,
  lang: 'en',
  dataDir: null,
  opencodeConfigDir: null,
  lookbackHours: 24,
  maxSessions: 30,
  thresholds: {
    stuckToolMinutes: 10,
    stuckToolMinutesByTool: { task: 60 },
    silentMinutes: 10,
    contextWarnPct: 80,
    compactionWarn: 3,
    sessionAgeWarnHours: 6,
    repeatWarn: 3,
    repeatWindow: 30,
    toolErrorWarn: 10,
  },
  contextLimit: { default: null, models: {} },
  processNames: ['opencode'],
  processCheck: true,
  redact: { enabled: true, extraPatterns: [] },
  environment: { checkSeconds: 15, modelServers: 'local' },
  services: [],
  work: { git: true, protectedBranches: ['main', 'master'] },
  review: { ignoreRules: [] },
  history: { enabled: true, file: 'data/history.jsonl', retentionDays: 30 },
  notify: {
    on: ['waiting', 'stuck'],
    environment: true,
    repeatMinutes: 30,
    desktop: true,
    discord: { webhookUrl: '', mention: '', includeDetail: false },
  },
};

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

function merge(base, extra) {
  const out = { ...base };
  for (const [key, value] of Object.entries(extra ?? {})) {
    out[key] = isPlainObject(value) && isPlainObject(base[key]) ? merge(base[key], value) : value;
  }
  return out;
}

export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new UserError(`${arg} needs a value.`);
      return argv[++i];
    };
    if (arg === '--port') args.port = Number(value());
    else if (arg === '--data-dir') args.dataDir = value();
    else if (arg === '--config') args.config = value();
    else if (arg === '--lang') args.lang = value();
    else if (arg === '--sample') args.sample = true;
    else if (arg === '--no-notify') args.noNotify = true;
    else if (arg === '--assume-running') args.assumeRunning = true;
    else if (arg === '--test-notify') args.testNotify = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new UserError(`Unknown option ${arg}. Try --help.`);
  }
  return args;
}

export const HELP = `Usage: node server.mjs [options]

  --port <n>         Port to listen on (default 4317). Always binds 127.0.0.1.
  --data-dir <path>  OpenCode data directory (the one holding opencode.db).
  --config <path>    Settings file (default: config.json next to server.mjs).
  --lang <code>      Language for notifications (en, th).
  --sample           Run against generated fake data; OpenCode not needed.
  --no-notify        Do not send desktop or Discord notifications.
  --assume-running   Skip the "is OpenCode running" process check.
  --test-notify      Send one test notification on each configured channel, then exit.
`;

export function defaultDataDir(env = process.env) {
  return env.XDG_DATA_HOME ? join(env.XDG_DATA_HOME, 'opencode') : join(homedir(), '.local', 'share', 'opencode');
}

export function defaultOpencodeConfigDir(env = process.env) {
  return env.XDG_CONFIG_HOME ? join(env.XDG_CONFIG_HOME, 'opencode') : join(homedir(), '.config', 'opencode');
}

export function loadConfig(args = {}, env = process.env) {
  const path = resolve(args.config ?? join(ROOT, 'config.json'));
  let fromFile = {};
  if (existsSync(path)) {
    try {
      fromFile = JSON.parse(readFileSync(path, 'utf8'));
    } catch (err) {
      throw new UserError(`Could not parse ${path}: ${err.message}`);
    }
  } else if (args.config) {
    throw new UserError(`Config file not found: ${path}`);
  }

  const cfg = merge(DEFAULTS, fromFile);
  if (env.OPENCODE_MONITOR_DISCORD_WEBHOOK) cfg.notify.discord.webhookUrl = env.OPENCODE_MONITOR_DISCORD_WEBHOOK;
  if (args.port !== undefined) cfg.port = args.port;
  if (args.lang) cfg.lang = args.lang;
  if (args.dataDir) cfg.dataDir = args.dataDir;
  if (args.assumeRunning) cfg.processCheck = false;
  if (args.noNotify) cfg.notify = merge(cfg.notify, { desktop: false, discord: { webhookUrl: '' } });

  if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) throw new UserError(`Invalid port: ${cfg.port}`);
  if (!(cfg.pollMs >= 500)) throw new UserError('pollMs must be at least 500.');
  if (!['off', 'local', 'all'].includes(cfg.environment.modelServers)) throw new UserError('environment.modelServers must be "off", "local", or "all".');
  if (!Array.isArray(cfg.services)) throw new UserError('services must be a list.');
  const hook = cfg.notify.discord.webhookUrl;
  if (hook && !/^https:\/\/(?:[\w-]+\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/.test(hook)) {
    throw new UserError('notify.discord.webhookUrl does not look like a Discord webhook URL (https://discord.com/api/webhooks/<id>/<token>).');
  }

  cfg.dataDir = resolve(cfg.dataDir ?? defaultDataDir(env));
  cfg.opencodeConfigDir = resolve(cfg.opencodeConfigDir ?? defaultOpencodeConfigDir(env));
  return cfg;
}
