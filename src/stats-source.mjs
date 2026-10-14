// Gathers the rows the stats page needs and caches the result. node:sqlite is synchronous,
// so each computation blocks the server briefly; caching keeps that to once a minute at most.
import { computeStats, summarize } from './stats.mjs';
import { takeawaysOf } from './takeaways.mjs';
import { clip } from './redact.mjs';
import { mergeServers } from './mcp.mjs';
import { allowedByRules, compactionPoint } from './opencode-config.mjs';
import { promptsFor } from './pending.mjs';
import { compareAt } from './compare.mjs';
import { recentOf } from './recent.mjs';

export const STATS_DAYS = [7, 14, 30];
const CACHE_MS = 60_000;
const MAX_CACHED = 24;
// Session ids are used as cache keys and compared with database rows, nothing else.
const SESSION_ID = /^[A-Za-z0-9_-]{1,80}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** The value when it is text of the expected shape, otherwise null. */
const matching = (value, shape) => (typeof value === 'string' && shape.test(value) ? value : null);

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

/** The value kept under `key` while it is fresh; otherwise computed, kept, and the oldest dropped. */
export function remembered(cache, key, now, compute) {
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_MS) return hit.value;
  const value = compute();
  if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value);
  cache.set(key, { at: now, value });
  return value;
}

/**
 * When each tool call was updated, oldest first: how a permission's answer is told. Only
 * calls that had a prompt need it, so only their sessions are read.
 * @returns {Map<string, number[]>} part id -> times
 */
export function updateTimes(db, tools, asks) {
  // A prompt is logged within two seconds of the call it is for.
  const prompted = p => asks.some(ask => Math.abs((p.started ?? p.time_created) - ask.t) <= 2000);
  const sessionsWithPrompts = new Set(tools.filter(prompted).map(p => p.session_id));
  const eventTimes = new Map();
  const note = ({ part_id: id, t }) => {
    if (!id || t == null) return;
    if (!eventTimes.has(id)) eventTimes.set(id, []);
    eventTimes.get(id).push(t);
  };
  for (const sessionId of sessionsWithPrompts) db.stats.toolEvents(sessionId).forEach(note);
  for (const times of eventTimes.values()) times.sort((x, y) => x - y);
  return eventTimes;
}

/**
 * A model's context window, and where OpenCode compacts a session of it in a directory: its
 * own rule, with the project's config over the global one. The window in the same order the
 * live page uses: config.json first, then OpenCode's own config.
 */
export function limitsFor({ cfg, projectMcp = null, modelLimits = new Map(), modelReserves = new Map(), compactionSettings = {}, outputTokenMax = null }) {
  // version: of the OpenCode whose session it is, whose rule is used.
  const compactAt = (provider, model, directory, version = null) => {
    const key = `${provider}/${model}`;
    const project = projectMcp?.settingsFor(directory);
    return compactionPoint(project?.limits.get(key) ?? modelLimits.get(key) ?? null, project?.reserves.get(key) ?? modelReserves.get(key), { ...compactionSettings, ...project?.compaction, outputTokenMax, version });
  };
  const contextLimit = (provider, model) => {
    const key = `${provider}/${model}`;
    return cfg.contextLimit?.models?.[key] ?? cfg.contextLimit?.models?.[model] ?? modelLimits.get(key) ?? cfg.contextLimit?.default ?? null;
  };
  return { compactAt, contextLimit };
}

/**
 * @param {object} deps
 * @param {object[]} [deps.mcpServers]  MCP servers from the global config
 * @param {object} [deps.projectMcp]    from createProjectMcp
 * @param {Map<string, number>} [deps.modelLimits]  "provider/model" -> context window
 * @param {(since: number) => number[]} [deps.configChangedAt]  when the config was changed
 */
export function createStatsSource({ db, log, cfg, redact, mcpServers = [], projectMcp = null, modelLimits = new Map(), modelReserves = new Map(), compactionSettings = {}, outputTokenMax = null, permissionRules = [], configChangedAt = () => [] }) {
  const { compactAt, contextLimit } = limitsFor({ cfg, projectMcp, modelLimits, modelReserves, compactionSettings, outputTokenMax });
  const show = (text, max) => clip(redact(String(text ?? '').slice(0, 2000)), max);
  const cache = new Map(); // "days|session" -> { at, value }

  /**
   * @param {string|null} [split] a day (YYYY-MM-DD) inside the range: also summarise the days
   *   before it and the days from it on, to see what a change made on that day did
   */
  const stats = function stats(askedDays, askedSession = null, askedSplit = null, now = Date.now()) {
    // What was asked comes from a URL or an assistant: anything unexpected becomes the default.
    const days = STATS_DAYS.includes(askedDays) ? askedDays : 14;
    const sessionId = matching(askedSession, SESSION_ID);
    const split = matching(askedSplit, DAY);
    const key = `${days}|${sessionId ?? ''}|${split ?? ''}`;
    return remembered(cache, key, now, () => compute(days, sessionId, split, now));
  };

  /**
   * The same figures before and after a moment, per hour of agent time: what a change did.
   * @param {number} at     milliseconds
   * @param {number} hours  each way, 1 to 168
   * @param {string|null} model  "provider/model": only its work, on both sides
   */
  stats.compareAt = (at, hours = 24, askedSession = null, now = Date.now(), model = null) => {
    const sessionId = matching(askedSession, SESSION_ID);
    const each = Math.min(168, Math.max(1, Number(hours) || 24));
    if (!Number.isFinite(at) || at > now) return { error: 'at must be a time in the past' };
    const input = inputFor(30, sessionId, now);
    let scope = null;
    if (sessionId) {
      scope = new Set([sessionId]);
      for (let grew = true; grew;) {
        grew = false;
        for (const s of input.sessions) if (s.parent_id && scope.has(s.parent_id) && !scope.has(s.id)) grew = scope.add(s.id) && true;
      }
    }
    return compareAt(input, at, each, scope, typeof model === 'string' && model.length <= 200 ? model : null);
  };
  return stats;

  function compute(days, sessionId, split, now) {
    const input = inputFor(days, sessionId, now);
    const value = computeStats(input);
    value.compare = compareAround(split, value, input);
    // Rates since the newest change of the config or the model, not over both setups.
    value.takeaways = takeawaysOf(value, recentOf(input, value, configChangedAt(value.range.from)));
    return value;
  }

  /** Every row the figures of a period are counted from. */
  function inputFor(days, sessionId, now) {
    // The rules as the config says now: read again with each figure, so a rule added since
    // the monitor started counts.
    const rules = typeof permissionRules === 'function' ? permissionRules() : permissionRules;
    const since = now - (days + 1) * 86_400_000;
    log.poll();
    const tools = db.stats.tools(since);
    const prompts = promptsFor(log, tools);
    const asks = prompts.asks.filter(a => a.t >= since);

    const eventTimes = updateTimes(db, tools, asks);

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
      spans: db.stats.spans(since),
      patches: db.stats.patches(since),
      todos: db.stats.todoStatus(),
      todoWrites: db.stats.todoWrites(since),
      todoWriters: db.stats.todoWriters(),
      compactions: db.stats.compactions(since),
      asks,
      replies: prompts.replies,
      liveRuns: log.liveRuns(),
      runEnds: log.runEnds(),
      eventTimes,
      now,
      days,
      stuckMs: cfg.thresholds.stuckToolMinutes * 60_000,
      show,
      allowedNow: (permission, patterns) => allowedByRules(rules, permission, patterns),
    };
    return input;
  }
}
