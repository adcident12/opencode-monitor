// Gathers the rows the stats page needs and caches the result. node:sqlite is synchronous,
// so each computation blocks the server briefly; caching keeps that to once a minute at most.
import { computeStats } from './stats.mjs';
import { clip } from './redact.mjs';

export const STATS_DAYS = [7, 14, 30];
const CACHE_MS = 60_000;

export function createStatsSource({ db, log, cfg, redact }) {
  const show = (text, max) => clip(redact(String(text ?? '').slice(0, 2000)), max);
  const cache = new Map(); // days -> { at, value }

  return function stats(days, now = Date.now()) {
    if (!STATS_DAYS.includes(days)) days = 14;
    const hit = cache.get(days);
    if (hit && now - hit.at < CACHE_MS) return hit.value;

    const since = now - (days + 1) * 86_400_000;
    log.poll();
    const tools = db.stats.tools(since);
    const asks = log.asks().filter(a => a.t >= since);

    // Update times are only needed for calls that had a prompt, so only their sessions are read.
    const sessionsWithPrompts = new Set();
    for (const ask of asks) {
      for (const p of tools) if (Math.abs((p.started ?? p.time_created) - ask.t) <= 2000) sessionsWithPrompts.add(p.session_id);
    }
    const eventTimes = new Map();
    for (const sessionId of sessionsWithPrompts) {
      for (const { part_id: id, t } of db.stats.toolEvents(sessionId)) {
        if (!id || t == null) continue;
        if (!eventTimes.has(id)) eventTimes.set(id, []);
        eventTimes.get(id).push(t);
      }
    }
    for (const times of eventTimes.values()) times.sort((a, b) => a - b);

    const value = computeStats({
      sessions: db.stats.sessions(since),
      tools,
      messages: db.stats.messages(since),
      compactions: db.stats.compactions(since),
      asks,
      replies: log.replies(),
      currentRun: log.lastRun(),
      runEnds: log.runEnds(),
      eventTimes,
      now,
      days,
      stuckMs: cfg.thresholds.stuckToolMinutes * 60_000,
      show,
    });
    cache.set(days, { at: now, value });
    return value;
  };
}
