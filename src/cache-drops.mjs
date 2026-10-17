// Prompt cache lost: a request whose prompt the model server had cached, most of it, and read
// again instead. OpenCode records for each request what came from the cache and what was read
// anew, so this is known for any server that reports cached tokens, local or not. Why it was
// lost is read off what happened in the session just before. Pure: rows in, figures out.

// A previous prompt smaller than this costs little to read again: not counted.
const MIN_PROMPT = 8192;
// Fewer tokens than this read again is noise (a few tool results moved).
const MIN_LOST = 4096;
// Keeping this share of the previous prompt is the cache working.
const KEPT_OK = 0.9;
// A pause longer than this: a server may have dropped the cache (cloud caches expire in minutes).
const PAUSE_MS = 5 * 60_000;
// Keeping this share at least, and losing the rest: the start held, something after it changed.
const PREFIX_KEPT = 0.3;
const TOP = 5;

const sent = m => (m.tokens_input ?? 0) + (m.tokens_cache_read ?? 0) + (m.tokens_cache_write ?? 0);
const modelOf = m => (m.provider_id ? `${m.provider_id}/${m.model_id}` : m.model_id);

/**
 * Why a request read again what it had cached, first that holds:
 *   compaction      OpenCode compacted the session: a new prompt, expected
 *   model_changed   another model answered: another cache, expected
 *   other_session   another session of this machine asked the same server in between: a slot
 *                   holds one prompt (another computer using the server is not seen, and shows
 *                   as new_turn or unexplained)
 *   pause           nothing was asked for a while: the server dropped the cache
 *   new_turn        the agent had ended its turn, and the next one began with the cache gone
 *   prefix_changed  the start of the prompt held and something after it changed
 *   unexplained     none of these
 */
function causeOf({ prev, request, kept, prevPrompt, compactedBetween, othersBetween }) {
  if (compactedBetween || prev.agent === 'compaction' || request.agent === 'compaction') return 'compaction';
  if (modelOf(prev) !== modelOf(request)) return 'model_changed';
  if (othersBetween) return 'other_session';
  if (request.time_created - (prev.completed ?? prev.time_created) > PAUSE_MS) return 'pause';
  // Said as it was seen: what changes in the prompt at a new turn is OpenCode's own.
  if (prev.finish === 'stop' && kept < PREFIX_KEPT * prevPrompt) return 'new_turn';
  if (kept >= PREFIX_KEPT * prevPrompt) return 'prefix_changed';
  return 'unexplained';
}

// Causes that are the working of OpenCode, not a problem to look into.
export const EXPECTED = new Set(['compaction', 'model_changed']);

/**
 * @param {object[]} messages  the period's messages, every session
 * @param {object} options
 * @param {number} options.from
 * @param {number} options.to
 * @param {(id: string) => boolean} [options.inScope]
 * @param {boolean} [options.each]  also every loss, oldest first (a replay marks each one)
 */
export function cacheDropsOf(messages, { from, to, inScope = () => true, readTps = () => null, each = false }) {
  const requests = messages.filter(m => m.role === 'assistant' && m.model_id && sent(m) > 0).sort((a, b) => a.time_created - b.time_created);
  // A model whose server never reported a cached token: every request would look like a loss.
  const reports = new Set(requests.filter(m => (m.tokens_cache_read ?? 0) > 0).map(modelOf));
  const compactions = messages.filter(m => m.agent === 'compaction');
  const bySession = new Map();
  for (const m of requests) {
    if (!bySession.has(m.session_id)) bySession.set(m.session_id, []);
    bySession.get(m.session_id).push(m);
  }

  const drops = [];
  let checked = 0;
  for (const [sessionId, list] of bySession) {
    if (!inScope(sessionId)) continue;
    for (let i = 1; i < list.length; i++) {
      const [prev, request] = [list[i - 1], list[i]];
      if (request.time_created < from || request.time_created > to || !reports.has(modelOf(request)) || sent(prev) < MIN_PROMPT) continue;
      checked++;
      const drop = dropOf(prev, request, { requests, compactions, readTps });
      if (drop) drops.push(drop);
    }
  }
  const summary = summaryOf(drops, checked);
  return each ? { ...summary, each: drops.toSorted((a, b) => a.t - b.t) } : summary;
}

// The prompt `request` read again of what `prev` had cached, and why; null when it kept it.
function dropOf(prev, request, { requests, compactions, readTps }) {
  const prevPrompt = sent(prev);
  const kept = request.tokens_cache_read ?? 0;
  if (kept >= KEPT_OK * prevPrompt) return null;
  // What it had and read again: bounded by what it read anew this time.
  const lost = Math.min(prevPrompt - kept, (request.tokens_input ?? 0) + (request.tokens_cache_write ?? 0));
  if (lost < MIN_LOST) return null;
  const sessionId = request.session_id;
  const since = prev.completed ?? prev.time_created;
  const between = m => m.time_created > since && m.time_created < request.time_created;
  const cause = causeOf({
    prev, request, kept, prevPrompt,
    compactedBetween: compactions.some(c => c.session_id === sessionId && between(c)),
    othersBetween: requests.some(m => m.session_id !== sessionId && m.provider_id === request.provider_id && between(m)),
  });
  // How long reading it again took, at the speed this model reads prompts on this machine.
  const tps = readTps(modelOf(request));
  return { t: request.time_created, session_id: sessionId, model: modelOf(request), lost, kept, prevPrompt, cause, pauseMs: request.time_created - since, ms: tps ? Math.round((lost / tps) * 1000) : null };
}

function summaryOf(drops, checked) {
  const sum = (list, key) => list.reduce((n, d) => n + (d[key] ?? 0), 0);
  const byCause = {};
  for (const d of drops) {
    byCause[d.cause] ??= { count: 0, tokens: 0, ms: 0 };
    byCause[d.cause].count++;
    byCause[d.cause].tokens += d.lost;
    byCause[d.cause].ms += d.ms ?? 0;
  }
  const unexpected = drops.filter(d => !EXPECTED.has(d.cause));
  return {
    checked,
    count: drops.length,
    tokens: sum(drops, 'lost'),
    // What is worth looking into: not what compaction or a change of model does anyway.
    unexpected: { count: unexpected.length, tokens: sum(unexpected, 'lost'), ms: sum(unexpected, 'ms') },
    byCause,
    largest: unexpected.toSorted((a, b) => b.lost - a.lost).slice(0, TOP),
  };
}
