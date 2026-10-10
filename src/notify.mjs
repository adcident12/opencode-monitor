// Tells the user when a session starts needing them: desktop notification and, if
// configured, a Discord webhook. Only already-redacted snapshot data is used here.
import { execFile } from 'node:child_process';
import { formatDuration } from './format.mjs';

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
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', TOAST_SCRIPT],
      { windowsHide: true, timeout: 15_000, env: { ...process.env, OCM_TITLE: title, OCM_BODY: body } }, done);
  } else if (process.platform === 'darwin') {
    execFile('osascript', ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', title, body],
      { timeout: 15_000 }, done);
  } else {
    execFile('notify-send', ['--app-name=opencode-monitor', title, body], { timeout: 15_000 }, done);
  }
}

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
  const sample = (id, state, health = {}) => ({
    id, parentId: null, state, since: now - 65_000, project: 'opencode-monitor', title: t('notify.test.body'),
    health: { hints: [], compactions: 0, compaction: null, compacting: false, ...health },
  });
  notifier([], now); // what is there at startup is never announced; start with nothing
  const kinds = cfg.on.length ? cfg.on : ['waiting'];
  for (const kind of kinds) {
    const session = kind === 'compact_soon'
      ? sample('test-compact', 'working', { hints: ['context_high'], compactions: 1, compaction: { at: 99_072, room: 9000, growth: 3000, requestsLeft: 3 } })
      : sample(`test-${kind}`, kind);
    notifier([session], now);
  }

  // Each channel reports back in its own time.
  const deadline = Date.now() + waitMs;
  const pending = () => notifier.recent().some(e => e.desktop === 'sending' || e.discord === 'sending');
  while (pending() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 200));
  for (const entry of notifier.recent().reverse()) {
    if (cfg.desktop) results.push([`${entry.kind} / desktop`, entry.desktop === 'sending' ? 'no answer' : entry.desktop]);
    if (cfg.discord.webhookUrl) results.push([`${entry.kind} / Discord`, entry.discord === 'sending' ? 'no answer' : entry.discord]);
  }
  return results;
}

/**
 * @param {object} cfg  the `notify` section of the config
 * @param {(key: string, vars?: object) => string} t
 * @param {object} [send] replaceable senders, for tests
 * @param {{quiet?: boolean}} [options] quiet: do not print a line per notification
 */
export function createNotifier(cfg, t, send = { desktop: desktopNotify, discord: discordNotify }, { quiet = false } = {}) {
  const seen = new Map(); // session id -> { state, notifiedAt }
  // session id -> how many times it had been compacted when it was last close to the next
  // one. Told once per compaction: the estimate of "requests left" wobbles, the count does not.
  const closeToCompaction = new Map();
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

  // Once per compaction: the session is close to the point where OpenCode compacts it.
  function compactSoon(session, now) {
    const c = session.health?.compaction;
    const lines = [
      `${session.project} — ${session.title}`,
      c ? t(c.requestsLeft == null ? 'notify.compact_room' : 'notify.compact_room_requests', { room: `${Math.round(c.room / 1000)}k`, n: c.requestsLeft ?? 0 }) : '',
    ].filter(Boolean);
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

  onSnapshot.environment = onEnvironment;
  /** For what is not about one session, such as the weekly summary. */
  onSnapshot.send = deliver;
  /** What was sent since the monitor started, newest first, with each channel's outcome. */
  onSnapshot.recent = () => recent.map(entry => ({ ...entry })).reverse();
  return onSnapshot;

  function onSnapshot(sessions, now) {
    const ids = new Set(sessions.map(s => s.id));
    for (const session of sessions) {
      // A subagent's prompt is reported once, through its parent.
      if (session.parentId && ids.has(session.parentId)) continue;
      const before = seen.get(session.id);
      const entry = { state: session.state, notifiedAt: before?.notifiedAt ?? 0 };
      const wanted = cfg.on.includes(session.state);
      const changed = before?.state !== session.state;
      const due = cfg.repeatMinutes > 0 && now - entry.notifiedAt >= cfg.repeatMinutes * 60_000;
      if (changed) entry.notifiedAt = 0;
      // What was already on screen when the monitor started is not news.
      if (wanted && !baseline && (changed || due)) {
        dispatch(session, now);
        entry.notifiedAt = now;
      } else if (wanted && baseline) {
        entry.notifiedAt = now;
      }
      seen.set(session.id, entry);

      // Not a state of its own: a warning that can come while the session works.
      const close = Boolean(session.health?.compaction) && session.health.hints?.includes('context_high');
      const compactions = session.health?.compactions ?? 0;
      if (close && !(closeToCompaction.get(session.id) >= compactions)) {
        if (cfg.on.includes('compact_soon') && !baseline) compactSoon(session, now);
        closeToCompaction.set(session.id, compactions);
      }
    }
    for (const id of closeToCompaction.keys()) if (!ids.has(id)) closeToCompaction.delete(id);
    for (const id of seen.keys()) if (!ids.has(id)) seen.delete(id);
    baseline = false;
  }
}
