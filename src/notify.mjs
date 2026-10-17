// Tells the user when a session starts needing them: desktop notification and, if
// configured, a Discord webhook. Only already-redacted snapshot data is used here.
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { formatDuration } from './format.mjs';
import { NOTIFY_SEND, OSASCRIPT, POWERSHELL } from './programs.mjs';

// How many sent notifications are remembered, for the "This machine" tab.
const RECENT_MAX = 50;

// Runs under Windows PowerShell 5.1 (ships with Windows). Text arrives through environment
// variables so nothing from a session title is ever parsed as script.
const TOAST_SCRIPT = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$text = $xml.GetElementsByTagName('text')
$text.Item(0).AppendChild($xml.CreateTextNode($env:OCM_TITLE)) | Out-Null
$text.Item(1).AppendChild($xml.CreateTextNode($env:OCM_BODY)) | Out-Null
$app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($xml))
`;

/** @param {(err: Error|null) => void} [onDone] called with the outcome, for --test-notify */
export function desktopNotify(title, body, onDone) {
  const done = err => {
    onDone?.(err ?? null);
    if (err && !onDone && !desktopNotify.warned) {
      desktopNotify.warned = true;
      console.warn(`Desktop notification failed (${err.code ?? err.message}); further failures are not reported.`);
    }
  };
  if (process.platform === 'win32') {
    execFile(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', TOAST_SCRIPT],
      { windowsHide: true, timeout: 15_000, env: { ...process.env, OCM_TITLE: title, OCM_BODY: body } }, done);
  } else if (process.platform === 'darwin') {
    execFile(OSASCRIPT, ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', title, body],
      { timeout: 15_000 }, done);
  } else {
    execFile(NOTIFY_SEND, ['--app-name=opencode-monitor', title, body], { timeout: 15_000 }, done);
  }
}

// How long an error must last before it is told: OpenCode 2 retries a failed request by itself
// within seconds ("The previous response was interrupted. Continue..."), and most are gone by then.
const ERROR_GRACE_MS = 60_000;

export async function discordNotify(webhookUrl, content, mention = '') {
  // Only the configured mention may ping; a session title containing @everyone must not.
  const allowed = { parse: [] };
  const target = /^<@(&?)(\d+)>$/.exec(mention);
  if (target) allowed[target[1] ? 'roles' : 'users'] = [target[2]];
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: content.slice(0, 1900), allowed_mentions: allowed }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) console.warn(`Discord webhook answered HTTP ${res.status}.`);
    return res.ok ? null : `HTTP ${res.status}`;
  } catch (err) {
    console.warn(`Discord notification failed: ${err.name}`);
    return err.name;
  }
}

/** A made-up session in the state that sets off one kind of notification. */
function sampleSession(kind, title, now) {
  const sample = (id, state, health = {}) => ({
    id, parentId: null, state, since: now - 65_000, project: 'opencode-monitor', title,
    health: { hints: [], compactions: 0, compaction: null, compacting: false, ...health },
  });
  if (kind === 'compact_soon') return sample('test-compact', 'working', { hints: ['context_high'], compactions: 1, compaction: { at: 99_072, room: 9000, growth: 3000, requestsLeft: 3 } });
  if (kind === 'dropped') return { ...sample('test-dropped', 'idle'), reason: 'dropped' };
  if (kind === 'server_idle') return { ...sample('test-server-idle', 'working'), reason: 'thinking', modelProgress: { phase: 'idle', idleMs: 90_000 } };
  if (kind === 'loop') return sample('test-loop', 'working', { loop: { kind: 'failing', id: 'failing:test', since: now - 65_000, tool: 'chrome-devtools_evaluate_script', times: 12 } });
  if (kind === 'budget') return { budget: { warnPct: 80, daily: { limit: 10, spent: 8.42, pct: 84, level: 'warn' }, monthly: null } };
  return sample(`test-${kind}`, kind);
}

/** One made-up case of a kind of notification, through the notifier as a real one goes. */
function sendSample(notifier, kind, t, now) {
  const session = sampleSession(kind, t('notify.test.body'), now);
  // Not about a session: what was spent against the budget.
  if (session.budget) return notifier.budget(session.budget, now, { test: true });
  // "dropped" is told of a session that was there before: first seen at work.
  if (kind === 'dropped') notifier([{ ...session, state: 'working', reason: 'tool' }], now);
  return notifier([session], now);
}

/**
 * Sends one sample of every kind of notification that is switched on (notify.on), through
 * the same code that sends the real ones, and reports how each channel answered. So what is
 * tested is the message you would get for "stuck" or "about to be compacted", not only that
 * the channel is reachable.
 * @returns {Promise<[string, string][]>} [what, outcome] pairs
 */
export async function testNotify(cfg, t, send = { desktop: desktopNotify, discord: discordNotify }, waitMs = 25_000) {
  const results = [];
  if (!cfg.desktop) results.push(['desktop', 'off in config']);
  if (!cfg.discord.webhookUrl) results.push(['Discord', 'no webhookUrl in config']);
  if (!cfg.desktop && !cfg.discord.webhookUrl) return results;

  const notifier = createNotifier(cfg, t, send, { quiet: true });
  const now = Date.now();
  notifier([], now); // what is there at startup is never announced; start with nothing
  for (const kind of cfg.on.length ? cfg.on : ['waiting']) sendSample(notifier, kind, t, now);

  // Each channel reports back in its own time.
  const deadline = Date.now() + waitMs;
  const pending = () => notifier.recent().some(e => e.desktop === 'sending' || e.discord === 'sending');
  while (pending() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 200));
  const outcome = answer => (answer === 'sending' ? 'no answer' : answer);
  for (const entry of notifier.recent().reverse()) {
    if (cfg.desktop) results.push([`${entry.kind} / desktop`, outcome(entry.desktop)]);
    if (cfg.discord.webhookUrl) results.push([`${entry.kind} / Discord`, outcome(entry.discord)]);
  }
  return results;
}

/** What was told of the budget, as the file keeps it; nothing for no file or a broken one. */
function readBudgetTold(file) {
  if (!file) return [];
  try {
    const kept = JSON.parse(readFileSync(file, 'utf8'));
    return ['daily', 'monthly'].filter(p => typeof kept?.[p] === 'string').map(p => [p, kept[p]]);
  } catch {
    return [];
  }
}

function writeBudgetTold(file, told) {
  if (!file) return;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(Object.fromEntries(told)));
  } catch (err) {
    console.warn(`Could not write ${file}: ${err.code ?? err.message}`);
  }
}

/**
 * @param {object} cfg  the `notify` section of the config
 * @param {(key: string, vars?: object) => string} t
 * @param {object} [send] replaceable senders, for tests
 * @param {{quiet?: boolean, budgetFile?: string|null}} [options] quiet: do not print a line per
 *   notification; budgetFile: remembers what was told of the budget, across restarts
 */
export function createNotifier(cfg, t, send = { desktop: desktopNotify, discord: discordNotify }, { quiet = false, budgetFile = null } = {}) {
  const seen = new Map(); // session id -> { state, notifiedAt }
  // session id -> how many times it had been compacted when it was last close to the next
  // one. Told once per compaction: the estimate of "requests left" wobbles, the count does not.
  const closeToCompaction = new Map();
  const serverIdleTold = new Set(); // sessions told of an idle server, until it works again
  const loopsTold = new Map(); // session id -> the loop episode it was told of
  let baseline = true;
  const recent = []; // what was sent, oldest first, with how each channel answered

  /**
   * Sends one notification on every channel that is on, and keeps the outcome: a message
   * that Discord refused or Windows did not show must not vanish without a trace.
   * @param {string} kind    'waiting', 'stuck', 'compact_soon', 'environment', ...
   * @param {string[]} lines first line says which session or thing it is about
   * @param {string} [extra] appended to the Discord message only
   * @param {{desktop?: boolean}} [channels] desktop: false for what a pop-up cannot hold
   */
  function deliver(kind, title, lines, now, extra = '', channels = {}) {
    const hook = cfg.discord.webhookUrl;
    const desktop = cfg.desktop && channels.desktop !== false;
    const entry = { t: now, kind, title, subject: lines[0] ?? '', desktop: desktop ? 'sending' : 'off', discord: hook ? 'sending' : 'off' };
    recent.push(entry);
    if (recent.length > RECENT_MAX) recent.shift();
    const settle = (channel, problem) => {
      entry[channel] = problem ? `failed (${problem})` : 'sent';
      if (problem) console.warn(`Notification "${kind}" was not delivered to ${channel}: ${problem}`);
    };
    if (desktop) send.desktop(title, lines.join(' · '), err => settle('desktop', err ? (err.code ?? err.message) : null));
    if (hook) {
      const text = [cfg.discord.mention, `**${title}**`, ...lines, extra].filter(Boolean).join('\n');
      // discordNotify answers with null, or with what went wrong as text.
      Promise.resolve(send.discord(hook, text, cfg.discord.mention)).then(problem => settle('discord', typeof problem === 'string' ? problem : null), err => settle('discord', err?.name ?? 'error'));
    }
    if (!quiet) console.log(`notified: ${kind} — ${entry.subject}`);
  }

  function dispatch(session, now) {
    const lines = [`${session.project} — ${session.title}`, t('notify.for', { t: formatDuration(now - session.since) })];
    const detail = session.prompt?.detail || session.current?.summary;
    deliver(session.state, t(`notify.${session.state}`), lines, now, cfg.discord.includeDetail && detail ? '`' + detail.replaceAll('`', "'") + '`' : '');
  }

  // Not a state you wait in: OpenCode gave up on a prompt nobody answered, and the session stopped.
  function dropped(session, now) {
    deliver('dropped', t('notify.dropped'), [`${session.project} — ${session.title}`, t('notify.dropped.body')], now);
  }

  // Once each time: the session waits on its model, and the model server works on nothing.
  function serverIdle(session, now) {
    const lines = [`${session.project} — ${session.title}`, t('notify.server_idle.body', { t: formatDuration(session.modelProgress.idleMs) })];
    deliver('server_idle', t('notify.server_idle'), lines, now);
  }

  // Once per episode: the agent goes round in circles (see loops.mjs).
  function loop(session, now) {
    const l = session.health.loop;
    const vars = { tool: l.tool ?? l.tools?.join(' → ') ?? '', n: l.times ?? 0, t: formatDuration(l.workMs ?? 0), calls: l.calls ?? 0 };
    deliver('loop', t(`notify.loop.${l.kind}`), [`${session.project} — ${session.title}`, t(`notify.loop.${l.kind}.body`, vars)], now);
  }

  // Once per compaction: the session is close to the point where OpenCode compacts it.
  function compactSoon(session, now) {
    const c = session.health?.compaction;
    const lines = [`${session.project} — ${session.title}`];
    if (c) {
      const key = c.requestsLeft == null ? 'notify.compact_room' : 'notify.compact_room_requests';
      lines.push(t(key, { room: `${Math.round(c.room / 1000)}k`, n: c.requestsLeft ?? 0 }));
    }
    deliver('compact_soon', t('notify.compact_soon'), lines, now);
  }

  // Environment: tell once when something that was fine (or not yet seen) goes down.
  const down = new Map(); // "mcp:graft" -> true while down
  let envBaseline = true;
  function onEnvironment(environment, now = Date.now()) {
    const items = [
      ...environment.mcp.map(m => ({ key: `mcp:${m.name}`, group: 'mcp', name: m.name, bad: m.status === 'failed' })),
      ...environment.models.map(m => ({ key: `model:${m.name}`, group: 'model', name: m.name, bad: m.ok === false })),
      ...environment.services.map(s => ({ key: `service:${s.name}`, group: 'service', name: s.name, bad: s.ok === false })),
    ];
    for (const item of items) {
      if (item.bad && !down.get(item.key) && !envBaseline) {
        deliver('environment', t(`notify.env.${item.group}`, { name: item.name }), [t('notify.env.body')], now);
      }
      down.set(item.key, item.bad);
    }
    envBaseline = false;
  }

  // Budget: told once a period when the share spent reaches warnPct, and once at the whole of it.
  // With a file, what was told is remembered across restarts, so a budget already spent when
  // the monitor starts is told if it was not yet; without one, that is taken as already known.
  const budgetTold = new Map(readBudgetTold(budgetFile)); // "daily" / "monthly" -> "<day or month>|<level>"
  let budgetBaseline = !budgetFile;
  function onBudget(budget, now = Date.now(), { test = false } = {}) {
    let changed = false;
    for (const period of ['daily', 'monthly']) {
      const b = budget?.[period];
      if (!b || b.level === 'ok') continue;
      const day = new Date(now).toLocaleDateString('sv-SE');
      const key = `${period === 'daily' ? day : day.slice(0, 7)}|${b.level}`;
      if (budgetTold.get(period) === key && !test) continue;
      if ((cfg.on.includes('budget') && !budgetBaseline) || test) {
        const vars = { spent: b.spent.toFixed(2), limit: b.limit.toFixed(2), pct: b.pct };
        deliver('budget', t(`notify.budget.${period}.${b.level}`, vars), [t(`notify.budget.${period}.body`, vars)], now);
      }
      if (!test) {
        budgetTold.set(period, key);
        changed = true;
      }
    }
    budgetBaseline = false;
    if (changed) writeBudgetTold(budgetFile, budgetTold);
  }

  onSnapshot.environment = onEnvironment;
  onSnapshot.budget = onBudget;
  /** For what is not about one session, such as the weekly summary. */
  onSnapshot.send = deliver;
  /** What was sent since the monitor started, newest first, with each channel's outcome. */
  onSnapshot.recent = () => recent.map(entry => ({ ...entry })).reverse();
  return onSnapshot;

  /** Tells about a session's state when it is one you asked for and it is new, or due again. */
  function onState(session, now) {
    const before = seen.get(session.id);
    const isDropped = session.state === 'idle' && session.reason === 'dropped';
    const entry = { state: session.state, notifiedAt: before?.notifiedAt ?? 0, dropped: isDropped };
    // Told once, when it happens: not for what was already so when the monitor started.
    if (isDropped && before && !before.dropped && !baseline && cfg.on.includes('dropped')) dropped(session, now);
    const wanted = cfg.on.includes(session.state);
    const changed = before?.state !== session.state;
    const due = cfg.repeatMinutes > 0 && now - entry.notifiedAt >= cfg.repeatMinutes * 60_000;
    if (changed) entry.notifiedAt = 0;
    // An error OpenCode gets over by itself (it asks the model again a moment later) is not
    // news: told only once it has lasted. Until then nothing is marked as told.
    const settling = session.state === 'error' && now - (session.since ?? now) < ERROR_GRACE_MS;
    // What was already on screen when the monitor started is not news.
    if (wanted && !baseline && !settling && (changed || due)) dispatch(session, now);
    if (wanted && (baseline || ((changed || due) && !settling))) entry.notifiedAt = now;
    seen.set(session.id, entry);
  }

  /** The model server works on nothing while the session waits on it: told once, until it works. */
  function onServerIdle(session, now) {
    if (session.modelProgress?.phase !== 'idle') {
      serverIdleTold.delete(session.id);
      return;
    }
    if (serverIdleTold.has(session.id)) return;
    if (cfg.on.includes('server_idle') && !baseline) serverIdle(session, now);
    serverIdleTold.add(session.id);
  }

  /** The agent going round in circles while it works: told once each time it starts. */
  function onLoop(session, now) {
    const l = session.health?.loop;
    const atWork = session.state === 'working' || session.state === 'stuck';
    if (!l || !atWork) return;
    if (loopsTold.get(session.id) === l.id) return;
    if (cfg.on.includes('loop') && !baseline) loop(session, now);
    loopsTold.set(session.id, l.id);
  }

  /** Not a state of its own: a warning that can come while the session works. */
  function onCloseToCompaction(session, now) {
    const close = Boolean(session.health?.compaction) && session.health.hints?.includes('context_high');
    const compactions = session.health?.compactions ?? 0;
    if (!close || closeToCompaction.get(session.id) >= compactions) return;
    if (cfg.on.includes('compact_soon') && !baseline) compactSoon(session, now);
    closeToCompaction.set(session.id, compactions);
  }

  function onSnapshot(sessions, now) {
    const ids = new Set(sessions.map(s => s.id));
    for (const session of sessions) {
      // A subagent goes round in circles on its own, and is told so.
      onLoop(session, now);
      // A subagent's prompt is reported once, through its parent.
      if (session.parentId && ids.has(session.parentId)) continue;
      onState(session, now);
      onCloseToCompaction(session, now);
      onServerIdle(session, now);
    }
    // What is known of sessions that are gone is forgotten.
    for (const known of [closeToCompaction, serverIdleTold, loopsTold, seen]) {
      for (const id of known.keys()) if (!ids.has(id)) known.delete(id);
    }
    baseline = false;
  }
}
