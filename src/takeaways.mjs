// A few things worth knowing, read off figures the Stats tab already shows. Pure: a stats
// result in, a short ranked list out.
//
// No guessing and no model: each takeaway is a fixed rule over figures that `npm run verify`
// checks, and each has a minimum of evidence below which it says nothing. Better to say
// nothing than to draw a conclusion from three sessions.

const MAX = 5;
const HOUR = 3_600_000;

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
    const top = s.work.permissions.top[0];
    if (!top || top.count < 3) return null;
    return { id: 'permission_repeat', tone: 'act', vars: { n: top.count, permission: top.permission, pattern: top.pattern }, anchor: 'stats-you' };
  },
  // An MCP server that often did not answer is broken, not merely slow. Three in hundreds of
  // calls is a hiccup, so it takes a share of the calls as well as a count.
  s => {
    const worst = s.mcp.filter(m => m.faults >= 3 && m.faults / m.calls >= 0.05).sort((a, b) => b.faults / b.calls - a.faults / a.calls)[0];
    if (!worst) return null;
    return { id: 'mcp_no_answer', tone: 'act', vars: { name: worst.name, n: worst.faults, calls: worst.calls }, anchor: 'stats-mcp' };
  },
  // Where the agent's time goes, when one part clearly dominates.
  s => {
    const t = s.work.time;
    const total = t.readingMs + t.thinkingMs + t.writingMs + t.toolMs;
    if (total < HOUR) return null;
    const [key, ms] = Object.entries(t).sort((a, b) => b[1] - a[1])[0];
    const pct = Math.round((ms / total) * 100);
    if (pct < 50) return null;
    return { id: `time_${key}`, tone: 'note', vars: { pct, hours: Math.round((ms / HOUR) * 10) / 10 }, anchor: 'stats-agent' };
  },
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
  s => {
    const pct = s.usage.cachedPct;
    if (pct == null || s.usage.requests < 50 || pct >= 50) return null;
    return { id: 'cache_low', tone: 'act', vars: { pct, requests: s.usage.requests }, anchor: 'stats-model' };
  },
  // A tool that fails often costs a retry each time.
  s => {
    const worst = [...s.tools].filter(t => t.count >= 20).sort((a, b) => b.errors / b.count - a.errors / a.count)[0];
    if (!worst) return null;
    const pct = Math.round((worst.errors / worst.count) * 100);
    if (pct < 15) return null;
    return { id: 'tool_failures', tone: 'note', vars: { tool: worst.tool, pct, n: worst.errors, calls: worst.count }, anchor: 'stats-agent' };
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

/** @param {object} stats  a result of computeStats */
export function takeawaysOf(stats) {
  const out = [];
  for (const rule of RULES) {
    const t = rule(stats);
    if (t) out.push(t);
    if (out.length === MAX) break;
  }
  return out;
}
