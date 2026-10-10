// Gathers the rows the stats page needs and caches the result. node:sqlite is synchronous,
// so each computation blocks the server briefly; caching keeps that to once a minute at most.
import { computeStats, summarize } from './stats.mjs';
import { clip } from './redact.mjs';
import { mergeServers } from './mcp.mjs';
import { compactionPoint } from './opencode-config.mjs';

export const STATS_DAYS = [7, 14, 30];
const CACHE_MS = 60_000;
const MAX_CACHED = 24;
// Session ids are used as cache keys and compared with database rows, nothing else.
const SESSION_ID = /^[A-Za-z0-9_-]{1,80}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The same rows counted twice: up to the end of the day before `split`, and from `split` on.
 * null when the day is not inside the range or leaves one side empty.
 */
function compareAround(split, whole, input) {
  const at = whole.daily.findIndex(d => d.date === split);
  if (at < 1) return null;
  const model = whole.speed.models[0]?.model ?? null;
  const midnight = new Date(`${split}T00:00:00`).getTime();
  const before = computeStats({ ...input, now: midnight - 1, days: at });
  const after = computeStats({ ...input, days: whole.daily.length - at });
  return { split, model, before: summarize(before, model), after: summarize(after, model) };
}

/**
 * @param {object} deps
 * @param {object[]} [deps.mcpServers]  MCP servers from the global config
 * @param {object} [deps.projectMcp]    from createProjectMcp
 * @param {Map<string, number>} [deps.modelLimits]  "provider/model" -> context window
 */
export function createStatsSource({ db, log, cfg, redact, mcpServers = [], projectMcp = null, modelLimits = new Map(), modelReserves = new Map(), compactionSettings = {}, outputTokenMax = null }) {
  // Where OpenCode compacts a session of this model in this directory: its own rule, with
  // the project's config over the global one.
  const compactAt = (provider, model, directory) => {
    const key = `${provider}/${model}`;
    const project = projectMcp?.settingsFor(directory);
    return compactionPoint(project?.limits.get(key) ?? modelLimits.get(key) ?? null, project?.reserves.get(key) ?? modelReserves.get(key), { ...compactionSettings, ...project?.compaction, outputTokenMax });
  };
  // The same order the live page uses: config.json first, then OpenCode's own config.
  const contextLimit = (provider, model) => {
    const key = `${provider}/${model}`;
    return cfg.contextLimit?.models?.[key] ?? cfg.contextLimit?.models?.[model] ?? modelLimits.get(key) ?? cfg.contextLimit?.default ?? null;
  };
  const show = (text, max) => clip(redact(String(text ?? '').slice(0, 2000)), max);
  const cache = new Map(); // "days|session" -> { at, value }

  /**
   * @param {string|null} [split] a day (YYYY-MM-DD) inside the range: also summarise the days
   *   before it and the days from it on, to see what a change made on that day did
   */
  return function stats(days, sessionId = null, split = null, now = Date.now()) {
    if (!STATS_DAYS.includes(days)) days = 14;
    if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) sessionId = null;
    if (typeof split !== 'string' || !DAY.test(split)) split = null;
    const key = `${days}|${sessionId ?? ''}|${split ?? ''}`;
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
    const input = {
      sessions,
      sessionId,
      contextLimit,
      compactAt,
      mcp: { servers: mergeServers(mcpServers, projectServers), events: log.mcpEvents(), logFrom: log.firstAt() },
      tools,
      messages: db.stats.messages(since),
      steps: new Map(db.stats.steps(since).map(s => [s.message_id, s])),
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
    };
    const value = computeStats(input);
    value.compare = compareAround(split, value, input);
    if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value);
    cache.set(key, { at: now, value });
    return value;
  };
}
