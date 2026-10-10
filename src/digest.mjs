// Once a week, the takeaways of the last seven days, sent to Discord. Off unless switched on
// (notify.weekly.enabled), and only to the webhook already configured: a desktop pop-up
// cannot hold five sentences, and no other channel exists.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { formatDuration } from './format.mjs';
import { takeawaysOf } from './takeaways.mjs';

const DAY = 86_400_000;

/**
 * The moment a summary falls due, if one does now: the latest "weekday at hour" (local time)
 * that has passed, unless one was already sent for it, or it passed more than a day ago (a
 * monitor started on Thursday does not send Monday's).
 * @param {number} weekday  0 Sunday .. 6 Saturday
 * @returns {number|null}
 */
export function digestDue({ now, weekday, hour, lastSent = 0, windowMs = DAY }) {
  const at = new Date(now);
  at.setHours(hour, 0, 0, 0);
  at.setDate(at.getDate() - ((at.getDay() - weekday + 7) % 7));
  if (at.getTime() > now) at.setDate(at.getDate() - 7);
  const due = at.getTime();
  return lastSent < due && now - due < windowMs ? due : null;
}

/**
 * The summary as lines of text. A permission's pattern can hold a path, so it is quoted only
 * when the config already allows details to be sent (notify.discord.includeDetail).
 */
export function digestLines(stats, t, { includeDetail = false } = {}) {
  const { totals } = stats;
  const lines = [t('digest.summary', { sessions: totals.sessions, active: formatDuration(totals.activeMs), wait: formatDuration(totals.waitMs) })];
  const takeaways = stats.takeaways ?? takeawaysOf(stats);
  for (const k of takeaways) {
    const key = k.id === 'permission_repeat' && !includeDetail ? 'digest.permission_repeat' : `takeaways.${k.id}`;
    lines.push(`• ${t(key, k.vars)}`);
  }
  if (!takeaways.length) lines.push(t('digest.none'));
  return lines;
}

/**
 * @param {object} o
 * @param {object} o.cfg       the `notify` section of the config
 * @param {(days: number) => object} o.stats
 * @param {Function} o.send    the notifier's `send(kind, title, lines, now, extra, channels)`
 * @param {string|null} o.stateFile  remembers the last summary sent, across restarts
 */
export function createDigest({ cfg, stats, send, t, stateFile = null }) {
  let lastSent = 0;
  if (stateFile) {
    try {
      lastSent = Number(JSON.parse(readFileSync(stateFile, 'utf8')).lastSent) || 0;
    } catch {
      // never sent, or a broken file: both mean "nothing sent yet"
    }
  }
  let checkedAt = -Infinity;

  /** Sends the summary now, whatever the day. @returns {string[]} the lines sent */
  function sendNow(now = Date.now()) {
    const lines = digestLines(stats(7), t, { includeDetail: cfg.discord.includeDetail });
    send('weekly', t('notify.weekly'), lines, now, '', { desktop: false });
    return lines;
  }

  function check(now = Date.now()) {
    if (!cfg.weekly?.enabled || !cfg.discord.webhookUrl || now - checkedAt < 60_000) return false;
    checkedAt = now;
    const due = digestDue({ now, weekday: cfg.weekly.weekday, hour: cfg.weekly.hour, lastSent });
    if (due == null) return false;
    // Marked first: a summary that fails to build must not be retried every minute.
    lastSent = due;
    if (stateFile) {
      try {
        mkdirSync(dirname(stateFile), { recursive: true });
        writeFileSync(stateFile, JSON.stringify({ lastSent }));
      } catch (err) {
        console.warn(`Could not write ${stateFile}: ${err.code ?? err.message}`);
      }
    }
    try {
      sendNow(now);
    } catch (err) {
      console.warn(`Weekly summary failed: ${err.code ?? err.message}`);
    }
    return true;
  }

  return { check, sendNow };
}
