// A rate over the whole period mixes what was before a change with what is now: a tool that
// failed often until a fix two days ago still reads as failing. The figures since the newest
// change, of the config or of the model, are what a rate takeaway should be read from.
import { computeStats } from './stats.mjs';

const HOUR = 3_600_000;
// Less agent time than this since the change is too little to read a rate from.
const MIN_ACTIVE_MS = HOUR;

const modelOf = m => (m.provider_id ? `${m.provider_id}/${m.model_id}` : m.model_id);

/**
 * When the model in use now took over: the first reply of it after the last reply of another.
 * Top-level sessions only: a subagent on a smaller model is not a change. null if one model.
 */
export function modelSwitchAt(messages, sessions, inScope = () => true) {
  const topLevel = new Set(sessions.filter(s => !s.parent_id).map(s => s.id));
  const replies = messages
    .filter(m => m.role === 'assistant' && m.agent !== 'compaction' && m.model_id && topLevel.has(m.session_id) && inScope(m.session_id))
    .toSorted((a, b) => a.time_created - b.time_created);
  if (!replies.length) return null;
  const now = modelOf(replies.at(-1));
  const other = replies.findLast(m => modelOf(m) !== now);
  if (!other) return null;
  return replies.find(m => m.time_created > other.time_created && modelOf(m) === now)?.time_created ?? null;
}

/** The rows of the input from `since` on. */
function rowsSince(input, since) {
  const after = t => t != null && t >= since;
  return {
    ...input,
    messages: input.messages.filter(m => after(m.time_created)),
    tools: input.tools.filter(p => after(p.started ?? p.time_created)),
    compactions: input.compactions.filter(c => after(c.time_created)),
    spans: (input.spans ?? []).filter(s => after(s.s)),
    patches: (input.patches ?? []).filter(p => after(p.time_created)),
    todoWrites: (input.todoWrites ?? []).filter(p => after(p.time_created)),
    asks: input.asks.filter(a => after(a.t)),
  };
}

/**
 * The figures since the newest change inside the period that has enough work after it: a
 * change made an hour ago has too little, and the one before it is read instead.
 * @param {object} input   the rows the whole period was counted from
 * @param {object} whole   computeStats of them
 * @param {number[]} configChanges  times the config was changed
 * @returns {{since: number, why: 'config'|'model', stats: object}|null}
 */
export function recentOf(input, whole, configChanges = []) {
  const from = whole.range.from;
  const inScope = id => !whole.session || id === whole.session.id;
  const model = modelSwitchAt(input.messages.filter(m => m.time_created > from), input.sessions, inScope);
  const moments = [
    ...configChanges.filter(t => t > from && t < input.now).map(t => ({ t, why: 'config' })),
    ...(model != null ? [{ t: model, why: 'model' }] : []),
  ].sort((a, b) => b.t - a.t);
  // Before the model now in use took over, the figures are another model's: no further back.
  for (const { t, why } of moments.filter(m => model == null || m.t >= model)) {
    const stats = computeStats(rowsSince(input, t));
    if (stats.totals.activeMs >= MIN_ACTIVE_MS) return { since: t, why, stats };
  }
  return null;
}
