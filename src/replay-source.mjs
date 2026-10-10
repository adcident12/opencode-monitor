// Reads one session and the sessions under it for a replay, and caches the result briefly:
// a session that is still going keeps changing, one that is over does not.
import { clip } from './redact.mjs';
import { buildReplay } from './replay.mjs';
import { limitsFor, remembered, updateTimes } from './stats-source.mjs';

const CACHE_MS = 10_000;
const MAX_CACHED = 12;
// Session ids are used as cache keys and compared with database rows, nothing else.
const SESSION_ID = /^[A-Za-z0-9_-]{1,80}$/;

export function createReplaySource({ db, log, cfg, redact, projectMcp = null, modelLimits, modelReserves, compactionSettings, outputTokenMax = null }) {
  const limits = limitsFor({ cfg, projectMcp, modelLimits, modelReserves, compactionSettings, outputTokenMax });
  const show = (text, max) => clip(redact(String(text ?? '').slice(0, 2000)), max);
  const cache = new Map();

  /** @returns {object|null} null for an id that is not a session */
  return function replay(sessionId, now = Date.now()) {
    if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return null;
    return remembered(cache, sessionId, now, () => {
      if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value);
      return compute(sessionId, now);
    });
  };

  function compute(sessionId, now) {
    // The session itself first: the query does not promise an order.
    const all = db.replay.tree(sessionId);
    const tree = [...all.filter(s => s.id === sessionId), ...all.filter(s => s.id !== sessionId)];
    if (tree[0]?.id !== sessionId) return null;
    const ids = tree.map(s => s.id);
    const from = Math.min(...tree.map(s => s.time_created));
    const to = Math.max(...tree.map(s => s.time_updated ?? s.time_created));
    log.poll();
    const asks = log.asks().filter(a => a.t >= from - 1000 && a.t <= to + 60_000);
    const tools = db.replay.tools(ids);
    // Other sessions' calls in the same hours, so a prompt is matched to the call it was for.
    const allTools = asks.length ? db.stats.tools(from).filter(p => (p.started ?? p.time_created) <= to + 60_000) : tools;
    return buildReplay({
      tree,
      messages: db.replay.messages(ids),
      tools,
      allTools,
      spans: db.replay.spans(ids),
      steps: new Map(db.replay.steps(ids).map(s => [s.message_id, s])),
      compactions: db.replay.compactions(ids),
      todoWrites: db.replay.todoWrites(ids),
      asks,
      replies: log.replies(),
      eventTimes: updateTimes(db, allTools, asks),
      now,
      stuckMs: cfg.thresholds.stuckToolMinutes * 60_000,
      show,
      ...limits,
    });
  }
}
