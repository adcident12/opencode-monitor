// What the monitor found on this machine, and what it could not find. Every figure the page
// shows comes from somewhere on the user's own machine: this says where from, so that when
// something is missing (a model with no known limit, a log that is not there) the reason is
// on screen instead of a blank.
//
// Read-only like everything else, and no secret is ever part of it: a webhook is reported as
// "set", never shown.
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { TESTED_OPENCODE, VERSION, isUntestedOpencode } from './config.mjs';
import { compactionPoint, outputTokenMaxFrom } from './opencode-config.mjs';

const MODEL_DAYS = 30;
const DAY_MS = 86_400_000;

const fileInfo = path => {
  try {
    const info = statSync(path);
    return { path, found: info.isFile(), bytes: info.size };
  } catch {
    return { path, found: false, bytes: null };
  }
};

/**
 * @param {object} input
 * @param {object} input.cfg        the monitor's own settings
 * @param {object} input.opencode   result of loadOpencodeConfig
 * @param {object|null} input.db    open database, or null when it was not found
 * @param {string|null} [input.opencodeVersion] version that wrote the newest session
 * @param {boolean|null} [input.running]        is an OpenCode process alive
 * @param {number|null} [input.historyCount]
 * @returns the report, in data only: the page and --doctor put the words to it
 */
export function buildSetupReport({ cfg, opencode, db, opencodeVersion = null, running = null, historyCount = null, notifications = [], env = process.env, now = Date.now() }) {
  const database = fileInfo(join(cfg.dataDir, 'opencode.db'));
  const log = fileInfo(join(cfg.dataDir, 'log', 'opencode.log'));
  const configFiles = ['opencode.json', 'opencode.jsonc'].filter(name => existsSync(join(cfg.opencodeConfigDir, name)));
  const outputTokenMax = outputTokenMaxFrom(env);
  const settings = { ...opencode.compaction, outputTokenMax };

  // The models actually used lately, each with what is known about its limits.
  const used = db ? db.stats.models(now - MODEL_DAYS * DAY_MS) : [];
  const models = used
    .filter(m => m.provider && m.model)
    .map(m => {
      const id = `${m.provider}/${m.model}`;
      const own = opencode.limits.get(id) ?? null;
      const override = cfg.contextLimit?.models?.[id] ?? cfg.contextLimit?.models?.[m.model] ?? null;
      const context = own ?? override ?? cfg.contextLimit?.default ?? null;
      const reserve = opencode.reserves.get(id);
      return {
        id,
        requests: m.requests,
        lastAt: m.last,
        context,
        output: reserve?.output ?? null,
        input: reserve?.input ?? null,
        // Where the window size came from: OpenCode's config, or the monitor's own override.
        source: sourceOf(own, context),
        compactAt: compactionPoint(context, reserve, settings),
      };
    })
    .sort((a, b) => b.lastAt - a.lastAt);

  const problems = [];
  const problem = (code, subject = null) => problems.push({ code, subject });
  if (!database.found) problem('no_database', database.path);
  if (!log.found) problem('no_log', log.path);
  if (!configFiles.length) problem('no_opencode_config', cfg.opencodeConfigDir);
  if (isUntestedOpencode(opencodeVersion) === true) problem('untested_opencode', opencodeVersion);
  if (opencode.compaction.auto === false) problem('compaction_off');
  for (const m of models) if (m.context == null) problem('model_limit_unknown', m.id);
  if (!cfg.notify.desktop && !cfg.notify.discord.webhookUrl) problem('no_notification');

  return {
    monitor: { version: VERSION, port: cfg.port, lang: cfg.lang, configFile: cfg.configFile ?? null, platform: process.platform },
    opencode: {
      dataDir: cfg.dataDir,
      database,
      log,
      configDir: cfg.opencodeConfigDir,
      configFiles,
      version: opencodeVersion,
      tested: TESTED_OPENCODE,
      running,
    },
    compaction: { auto: opencode.compaction.auto !== false, reserved: opencode.compaction.reserved ?? null, outputTokenMax },
    models,
    mcp: opencode.mcp.map(s => ({ name: s.name, type: s.type, enabled: s.enabled })),
    notify: {
      desktop: Boolean(cfg.notify.desktop),
      // Whether one is set. The URL itself is a password and never leaves the config.
      discord: Boolean(cfg.notify.discord.webhookUrl),
      on: [...cfg.notify.on],
      repeatMinutes: cfg.notify.repeatMinutes,
      // The week's takeaways, to Discord only: nothing is sent without a webhook.
      weekly: { enabled: Boolean(cfg.notify.weekly?.enabled), weekday: cfg.notify.weekly?.weekday ?? 1, hour: cfg.notify.weekly?.hour ?? 9 },
      // What was sent since this monitor started, newest first, and how each channel answered.
      recent: notifications.slice(0, 20),
    },
    history: { enabled: Boolean(cfg.history.enabled), file: cfg.history.file, retentionDays: cfg.history.retentionDays, count: historyCount },
    problems,
  };
}

// 4 January 1970 was a Sunday, so day 4 + n is weekday n.
const weekdayName = (weekday, lang) => new Intl.DateTimeFormat(lang, { weekday: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(1970, 0, 4 + weekday)));

/** When the weekly summary goes out, or why it does not. */
export function weeklyText(notify, t, lang = 'en') {
  if (!notify.weekly?.enabled) return t('setup.no');
  if (!notify.discord) return t('setup.weeklyNoHook');
  return t('setup.weeklyAt', { day: weekdayName(notify.weekly.weekday, lang), hour: String(notify.weekly.hour).padStart(2, '0') });
}

const yes = (t, value) => t(value ? 'setup.yes' : 'setup.no');
/** Where a model's window size came from: OpenCode's config, or the monitor's own override. */
function sourceOf(own, context) {
  if (own != null) return 'opencode';
  return context == null ? null : 'monitor';
}

function kilo(n) {
  if (n == null) return '?';
  return n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n);
}

/** The same report as plain text, for `node server.mjs --doctor`. */
export function formatSetupReport(report, t, lang = 'en') {
  const { monitor, opencode, compaction, models, mcp, notify, history, problems } = report;
  const lines = [];
  const head = key => lines.push('', t(key));
  const row = (key, value) => lines.push(`  ${t(key)}: ${value}`);
  const found = file => `${file.path} ${file.found ? '' : `(${t('setup.notFound')})`}`.trimEnd();

  lines.push(`opencode-monitor ${monitor.version ?? ''}`.trim());
  head('setup.monitor');
  row('setup.configFile', monitor.configFile ? found(monitor.configFile) : '-');
  row('setup.port', monitor.port);

  head('setup.opencode');
  row('setup.database', found(opencode.database));
  row('setup.log', found(opencode.log));
  row('setup.opencodeConfig', opencode.configFiles.length ? opencode.configFiles.map(f => join(opencode.configDir, f)).join(', ') : `${opencode.configDir} (${t('setup.notFound')})`);
  row('setup.opencodeVersion', `${opencode.version ?? '?'} (${t('setup.testedWith', { v: opencode.tested })})`);

  head('setup.compaction');
  row('setup.compactionAuto', yes(t, compaction.auto));
  if (compaction.reserved != null) row('setup.compactionReserved', compaction.reserved);
  if (compaction.outputTokenMax != null) row('setup.outputTokenMax', compaction.outputTokenMax);

  head('setup.models');
  if (!models.length) lines.push(`  ${t('setup.noModels')}`);
  for (const m of models) {
    const compactAt = m.compactAt == null ? '-' : kilo(m.compactAt);
    const limits = m.context == null ? t('setup.limitUnknown') : `${t('setup.context')} ${kilo(m.context)}, ${t('setup.compactAt')} ${compactAt}`;
    lines.push(`  ${m.id}: ${limits}`);
  }

  head('setup.mcp');
  lines.push(`  ${mcp.length ? mcp.map(s => `${s.name}${s.enabled ? '' : ` (${t('stats.mcpOff')})`}`).join(', ') : t('setup.none')}`);

  head('setup.notify');
  row('setup.desktop', yes(t, notify.desktop));
  row('setup.discord', yes(t, notify.discord));
  row('setup.notifyOn', notify.on.join(', ') || t('setup.none'));
  row('setup.weekly', weeklyText(notify, t, lang));

  head('setup.history');
  row('setup.historyFile', history.enabled ? `${history.file} (${t('setup.keptDays', { n: history.retentionDays })})` : t('setup.no'));

  head('setup.problems');
  if (!problems.length) lines.push(`  ${t('setup.noProblems')}`);
  for (const p of problems) lines.push(`  ! ${t(`setup.problem.${p.code}`, { subject: p.subject ?? '' })}`);
  return lines.join('\n');
}
