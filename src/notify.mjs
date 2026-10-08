// Tells the user when a session starts needing them: desktop notification and, if
// configured, a Discord webhook. Only already-redacted snapshot data is used here.
import { execFile } from 'node:child_process';
import { formatDuration } from './format.mjs';

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

export function desktopNotify(title, body) {
  const done = err => {
    if (err && !desktopNotify.warned) {
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
  } catch (err) {
    console.warn(`Discord notification failed: ${err.name}`);
  }
}

/**
 * @param {object} cfg  the `notify` section of the config
 * @param {(key: string, vars?: object) => string} t
 * @param {object} [send] replaceable senders, for tests
 */
export function createNotifier(cfg, t, send = { desktop: desktopNotify, discord: discordNotify }) {
  const seen = new Map(); // session id -> { state, notifiedAt }
  let baseline = true;

  function compose(session, now) {
    const title = t(`notify.${session.state}`);
    const lines = [`${session.project} — ${session.title}`, t('notify.for', { t: formatDuration(now - session.since) })];
    const detail = session.prompt?.detail || session.current?.summary;
    return { title, lines, detail };
  }

  function dispatch(session, now) {
    const { title, lines, detail } = compose(session, now);
    if (cfg.desktop) send.desktop(title, lines.join(' · '));
    if (cfg.discord.webhookUrl) {
      const parts = [cfg.discord.mention, `**${title}**`, ...lines].filter(Boolean);
      if (cfg.discord.includeDetail && detail) parts.push('`' + detail.replaceAll('`', "'") + '`');
      send.discord(cfg.discord.webhookUrl, parts.join('\n'), cfg.discord.mention);
    }
  }

  // Environment: tell once when something that was fine (or not yet seen) goes down.
  const down = new Map(); // "mcp:graft" -> true while down
  let envBaseline = true;
  function onEnvironment(environment) {
    const items = [
      ...environment.mcp.map(m => ({ key: `mcp:${m.name}`, group: 'mcp', name: m.name, bad: m.status === 'failed' })),
      ...environment.models.map(m => ({ key: `model:${m.name}`, group: 'model', name: m.name, bad: m.ok === false })),
      ...environment.services.map(s => ({ key: `service:${s.name}`, group: 'service', name: s.name, bad: s.ok === false })),
    ];
    for (const item of items) {
      if (item.bad && !down.get(item.key) && !envBaseline) {
        const title = t(`notify.env.${item.group}`, { name: item.name });
        if (cfg.desktop) send.desktop(title, t('notify.env.body'));
        if (cfg.discord.webhookUrl) send.discord(cfg.discord.webhookUrl, [cfg.discord.mention, `**${title}**`].filter(Boolean).join('\n'), cfg.discord.mention);
      }
      down.set(item.key, item.bad);
    }
    envBaseline = false;
  }

  onSnapshot.environment = onEnvironment;
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
    }
    for (const id of seen.keys()) if (!ids.has(id)) seen.delete(id);
    baseline = false;
  }
}
