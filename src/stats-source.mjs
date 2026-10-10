// Gathers the rows the stats page needs and caches the result. node:sqlite is synchronous,
// so each computation blocks the server briefly; caching keeps that to once a minute at most.
import { computeStats } from './stats.mjs';
import { clip } from './redact.mjs';
import { mergeServers } from './mcp.mjs';

export const STATS_DAYS = [7, 14, 30];
const CACHE_MS = 60_000;
const MAX_CACHED = 24;
// Session ids are used as cache keys and compared with database rows, nothing else.
const SESSION_ID = /^[A-Za-z0-9_-]{1,80}$/;

/**
 * @param {object} deps
 * @param {object[]} [deps.mcpServers]  MCP servers from the global config
 * @param {object} [deps.projectMcp]    from createProjectMcp
 */
export function createStatsSource({ db, log, cfg, redact, mcpServers = [], projectMcp = null }) {
  const show = (text, max) => clip(redact(String(text ?? '').slice(0, 2000)), max);
  const cache = new Map(); // "days|session" -> { at, value }

  return function stats(days, sessionId = null, now = Date.now()) {
    if (!STATS_DAYS.includes(days)) days = 14;
    if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) sessionId = null;
    const key = `${days}|${sessionId ?? ''}`;
    const hit = cache.get(key);
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

    const sessions = db.stats.sessions(since);
    // Servers a project config adds count only for the projects in the range.
    const projectServers = projectMcp?.forDirs(sessions.map(s => s.directory)) ?? [];
    const value = computeStats({
      sessions,
      sessionId,
      mcp: { servers: mergeServers(mcpServers, projectServers), events: log.mcpEvents(), logFrom: log.firstAt() },
      tools,
      messages: db.stats.messages(since),
      compactions: db.stats.compactions(since),
      asks,
      replies: log.replies(),
      liveRuns: log.liveRuns(),
      runEnds: log.runEnds(),
      eventTimes,
      now,
      days,
      stuckMs: cfg.thresholds.stuckToolMinutes * 60_000,
      show,
    });
    if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value);
    cache.set(key, { at: now, value });
    return value;
  };
}
