// A few things worth knowing, read off figures the Stats tab already shows. Pure: a stats
// result in, a short ranked list out.
//
// No guessing and no model: each takeaway is a fixed rule over figures that `npm run verify`
// checks, and each has a minimum of evidence below which it says nothing. Better to say
// nothing than to draw a conclusion from three sessions.

const MAX = 5;
const HOUR = 3_600_000;
// A tool counts as failing often from this share of its calls.
const FAILING_PCT = 15;

/** A tool's calls and failures, leaving out scripts that looped: they are their own line. */
const ownCalls = t => ({ count: t.count - (t.loop?.calls ?? 0), errors: t.errors - (t.loop?.errors ?? 0) });
const worstTool = tools => tools
  .map(t => ({ ...t, ...ownCalls(t) }))
  .filter(t => t.count >= 20)
  .sort((a, b) => b.errors / b.count - a.errors / a.count)[0];

/** A moment as this machine's clock reads it, to the minute: 2026-10-12 16:19. */
export function shortTime(t) {
  const d = new Date(t);
  const two = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

/**
 * Each rule returns null, or { id, tone, vars, anchor }:
 *   tone   'act' when there is something to change, 'note' when it is only worth knowing
 *   vars   the figures the sentence quotes; the page writes the sentence in its language
 *   anchor the chapter that has the details
 * Listed most useful first: the first five that apply are shown.
 */
const RULES = [
  // Replies cut off by the output limit lose work: the cheapest fix there is.
  s => {
    const n = s.work.turns.ended.cut;
    if (n < 1) return null;
    const models = [...new Set(s.work.turns.cut.map(c => c.model).filter(Boolean))];
    return { id: 'cut_off', tone: 'act', vars: { n, models: models.join(', ') }, anchor: 'stats-agent' };
  },
  // Switched on, never called, and each still adds its tools to every prompt.
  s => {
    const unused = s.mcp.filter(m => m.unused).map(m => m.name);
    if (!unused.length || s.totals.sessions < 3) return null;
    return { id: 'mcp_unused', tone: 'act', vars: { n: unused.length, names: unused.join(', '), sessions: s.totals.sessions }, anchor: 'stats-mcp' };
  },
  // The same permission asked again and again is a rule waiting to be written.
  s => {
    // One a rule in the config lets through now is fixed already.
    const top = s.work.permissions.top.find(g => !g.allowedNow);
    if (!top || top.count < 3) return null;
    return { id: 'permission_repeat', tone: 'act', vars: { n: top.count, permission: top.permission, pattern: top.pattern }, anchor: 'stats-you' };
  },
  // OpenCode named replies after a model the server did not have loaded: every figure of that
  // model is another's. Ten at least, so a switch caught mid-reply is not one.
  s => {
    const top = s.servedAs?.differ?.[0];
    if (!top || top.replies < 10) return null;
    return { id: 'served_other', tone: 'act', vars: { n: top.replies, asked: top.asked, served: top.served }, anchor: 'stats-model' };
  },
  // The model server read whole prompts again, and the sessions waited on it.
  s => {
    const r = s.longReads;
    if (!r || r.count < 3 || r.ms < 10 * 60_000) return null;
    return { id: 'long_reads', tone: 'note', vars: { n: r.count, minutes: Math.round(r.ms / 60_000), tokens: Math.round(r.tokens / 1000) }, anchor: 'stats-model' };
  },
  // Summarising took a real share of the agent's time.
  s => {
    const { compactingMs, activeMs, compactions } = s.totals;
    if ((compactingMs ?? 0) < 30 * 60_000 || !activeMs || compactingMs / activeMs < 0.1) return null;
    return { id: 'compacting_time', tone: 'note', vars: { pct: Math.round((compactingMs / activeMs) * 100), hours: Math.round((compactingMs / 3_600_000) * 10) / 10, n: compactions }, anchor: 'stats-agent' };
  },
  // One session that went on through many compactions: each costs the detail of what came before.
  s => {
    // With one session picked, only that one.
    const pool = s.session ? (s.sessions ?? []).filter(x => x.id === s.session.id) : (s.sessions ?? []);
    const long = pool.filter(x => x.compactions >= 20).sort((a, b) => b.compactions - a.compactions)[0];
    if (!long) return null;
    return { id: 'long_session', tone: 'act', vars: { n: long.compactions, hours: Math.round((long.activeMs / 3_600_000) * 10) / 10 }, anchor: 'stats-model' };
  },
  // An MCP server that often did not answer is broken, not merely slow. Three in hundreds of
  // calls is a hiccup, so it takes a share of the calls as well as a count.
  s => {
    const worst = s.mcp.filter(m => m.faults >= 3 && m.faults / m.calls >= 0.05).sort((a, b) => b.faults / b.calls - a.faults / a.calls)[0];
    if (!worst) return null;
    return { id: 'mcp_no_answer', tone: 'act', vars: { name: worst.name, n: worst.faults, calls: worst.calls }, anchor: 'stats-mcp' };
  },
  // Where the agent's time goes, when one part clearly dominates.
  Object.assign(s => {
    const t = s.work.time;
    const total = t.readingMs + t.thinkingMs + t.writingMs + t.toolMs;
    if (total < HOUR) return null;
    const [key, ms] = Object.entries(t).sort((a, b) => b[1] - a[1])[0];
    const pct = Math.round((ms / total) * 100);
    if (pct < 50) return null;
    return { id: `time_${key}`, tone: 'note', vars: { pct, hours: Math.round((ms / HOUR) * 10) / 10 }, anchor: 'stats-agent' };
  }, { rate: 'time' }),
  // Many compactions per session: details are being lost, and files read again.
  s => {
    const { sessions, compactions, rereads } = s.totals;
    if (sessions < 3) return null;
    const per = compactions / sessions;
    if (per < 2) return null;
    // Files read again are named only when there were some: "0 files were read" says nothing.
    const id = rereads > 0 ? 'compactions_rereads' : 'compactions';
    return { id, tone: 'act', vars: { per: Math.round(per * 10) / 10, sessions, rereads }, anchor: 'stats-model' };
  },
  // A prompt cache that is barely reused makes every request read everything again.
  Object.assign(s => {
    const pct = s.usage.cachedPct;
    if (pct == null || s.usage.requests < 50 || pct >= 50) return null;
    return { id: 'cache_low', tone: 'act', vars: { pct, requests: s.usage.requests }, anchor: 'stats-model' };
  }, { rate: 'cache_low' }),
  // A tool that fails often costs a retry each time.
  Object.assign(s => {
    const worst = worstTool(s.tools);
    if (!worst) return null;
    const pct = Math.round((worst.errors / worst.count) * 100);
    if (pct < FAILING_PCT) return null;
    return { id: 'tool_failures', tone: 'note', vars: { tool: worst.tool, pct, n: worst.errors, calls: worst.count }, anchor: 'stats-agent' };
  }, { rate: 'tool_failures' }),
  // Rates (marked `rate`) are read from the figures since the newest change when there are
// enough of them: before it they describe a setup that is gone. Such a takeaway carries
// `since`, and its sentence is said as from then.
// A tool that failed often over the period and no longer does since the change: fixed, not failing.
  (s, recent) => {
    if (!recent) return null;
    const was = worstTool(s.tools);
    if (!was || (was.errors / was.count) * 100 < FAILING_PCT) return null;
    const now = recent.stats.tools.find(t => t.tool === was.tool);
    const own = now && ownCalls(now);
    if (!own || own.count < 20 || (own.errors / own.count) * 100 >= FAILING_PCT) return null;
    return { id: 'tool_failures_better', tone: 'note', vars: { tool: was.tool, was: Math.round((was.errors / was.count) * 100), pct: Math.round((own.errors / own.count) * 100), n: own.errors, calls: own.count, since: shortTime(recent.since) }, anchor: 'stats-agent' };
  },
  // A script that looped: one line for it, not a failure rate for the tool it called.
  s => {
    const looped = s.tools.filter(t => t.loop).sort((a, b) => b.loop.calls - a.loop.calls)[0];
    if (!looped) return null;
    return { id: 'script_loop', tone: 'note', vars: { tool: looped.tool, scripts: looped.loop.scripts, calls: looped.loop.calls, n: looped.loop.errors }, anchor: 'stats-agent' };
  },
  // You waited a long time, in all.
  s => {
    const { waitMs, prompts } = s.totals;
    if (waitMs < HOUR || prompts < 2) return null;
    return { id: 'waited', tone: 'note', vars: { hours: Math.round((waitMs / HOUR) * 10) / 10, prompts }, anchor: 'stats-you' };
  },
  // Plans that keep being replaced before they are done.
  s => {
    const { total, dropped } = s.work.plans;
    if (total < 10 || dropped / total < 0.3) return null;
    return { id: 'plans_left', tone: 'note', vars: { n: dropped, total, pct: Math.round((dropped / total) * 100) }, anchor: 'stats-done' };
  },
];

/**
 * @param {object} stats   a result of computeStats
 * @param {{since: number, why: string, stats: object}|null} [recent]  the figures since the
 *   newest change of the config or the model (see recent.mjs): rates are read from them
 */
export function takeawaysOf(stats, recent = null) {
  const out = [];
  for (const rule of RULES) {
    let t;
    if (rule.rate && recent) {
      t = rule(recent.stats);
      if (t) Object.assign(t, { since: recent.since, vars: { ...t.vars, since: shortTime(recent.since) } });
    } else {
      t = rule(stats, recent);
    }
    if (t) out.push(t);
    if (out.length === MAX) break;
  }
  return out;
}
