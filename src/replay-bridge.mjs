// The whole bridge on one day: every session that did something that day, each as its own
// replay, so the page can show them side by side at one moment. Days are this machine's own
// days, midnight to midnight, since that is how its owner remembers them.
import { remembered } from './stats-source.mjs';

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
/** As many stations as the live bridge has room for. */
export const MAX_BRIDGE = 12;
export const BRIDGE_DAYS = 30;

const two = n => String(n).padStart(2, '0');

/** The day a moment falls on, here: 2026-10-09. */
export function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

/** Where a day starts and where the next one does; null for what is not a day. */
export function dayBounds(day) {
  const m = DAY.exec(String(day ?? ''));
  if (!m) return null;
  const [y, mo, d] = m.slice(1).map(Number);
  const start = new Date(y, mo - 1, d);
  // 2026-02-31 is not a day, though it looks like one.
  if (start.getMonth() !== mo - 1 || start.getDate() !== d) return null;
  return [start.getTime(), new Date(y, mo - 1, d + 1).getTime()];
}

/**
 * Which sessions did something on which day: a session of your own (not a subagent) counts
 * for each day it has a message on.
 * @returns {Map<string, Set<string>>} day -> session ids
 */
export function activeDays(sessions, messages) {
  const own = new Set(sessions.filter(s => !s.parent_id).map(s => s.id));
  const days = new Map();
  for (const m of messages) {
    if (!own.has(m.session_id)) continue;
    const day = dayKey(m.time_created);
    if (!days.has(day)) days.set(day, new Set());
    days.get(day).add(m.session_id);
  }
  return days;
}

export function createBridgeSource({ db, replay }) {
  const cache = new Map();
  const active = now => remembered(cache, 'days', now, () => {
    const since = now - (BRIDGE_DAYS + 1) * 86_400_000;
    const sessions = db.stats.sessions(since);
    return { sessions, days: activeDays(sessions, db.stats.messages(since)) };
  });

  return {
    /** The days there is something to play back, newest first, with how many sessions each. */
    days(now = Date.now()) {
      const first = now - BRIDGE_DAYS * 86_400_000;
      return [...active(now).days]
        .filter(([day]) => dayBounds(day)[1] > first)
        .map(([day, ids]) => ({ day, sessions: ids.size }))
        .sort((a, b) => (a.day < b.day ? 1 : -1));
    },

    /** @returns {object|null} null for what is not a day */
    bridge(day, now = Date.now()) {
      const bounds = dayBounds(day);
      if (!bounds) return null;
      const { sessions, days } = active(now);
      const ids = days.get(day) ?? new Set();
      // In the order they began, so each keeps its station through the day.
      const on = sessions.filter(s => ids.has(s.id)).sort((a, b) => a.time_created - b.time_created);
      return {
        day,
        start: bounds[0],
        end: Math.min(bounds[1], now),
        now,
        sessions: on.slice(0, MAX_BRIDGE).map(s => replay(s.id, now)).filter(Boolean),
        more: Math.max(0, on.length - MAX_BRIDGE),
      };
    },
  };
}
