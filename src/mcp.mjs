// What can be said about MCP servers from OpenCode's records. Pure: rows in, figures out.
//
// OpenCode records no "connected" state, so everything here is read off two things: the
// tool calls in the database (a tool of server X is named "X_<tool>") and the failure lines
// in the log.

const SHUTDOWN_MS = 2000;
const TOP_TOOLS = 8;

// The transport's own errors, as opposed to a tool being called wrongly.
const CONNECTION = /MCP error -32000|Connection closed|Not connected/i;
const TIMEOUT = /MCP error -32001|Request timed out/i;

/** 'connection' | 'timeout' when the error says the server itself did not answer, else null. */
export function faultOf(error) {
  if (!error) return null;
  const text = String(error);
  if (CONNECTION.test(text)) return 'connection';
  return TIMEOUT.test(text) ? 'timeout' : null;
}

/** OpenCode builds tool names from the server name with everything else turned into "_". */
export const toolPrefix = name => String(name).replace(/[^a-zA-Z0-9_-]/g, '_') + '_';

/** @returns {(tool: string) => {server: string, tool: string} | null} */
export function createServerMatcher(names) {
  // Longest first, so "chrome-devtools_click" is not attributed to a server named "chrome".
  const prefixes = [...new Set(names)].map(name => ({ name, prefix: toolPrefix(name) })).sort((a, b) => b.prefix.length - a.prefix.length);
  return tool => {
    const hit = typeof tool === 'string' ? prefixes.find(p => tool.startsWith(p.prefix)) : null;
    return hit ? { server: hit.name, tool: tool.slice(hit.prefix.length) } : null;
  };
}

/**
 * Servers from the global config, plus what project configs add or switch on.
 * A server counts as enabled if it is enabled anywhere it is defined.
 */
export function mergeServers(global, project = []) {
  const merged = new Map(global.map(s => [s.name, { ...s, scope: 'global' }]));
  for (const s of project) {
    const known = merged.get(s.name);
    if (known) known.enabled ||= s.enabled;
    else merged.set(s.name, { name: s.name, type: s.type ?? 'local', enabled: s.enabled, scope: 'project' });
  }
  return [...merged.values()];
}

/**
 * Marks "MCP connection closed" lines that are OpenCode shutting down, not a server dying:
 * the last thing a finished run wrote, or several servers closing in the same moment.
 * One server closing alone while its run goes on is the only case counted as a failure.
 */
export function markShutdowns(events, runEnds = new Map(), live = new Set()) {
  const closesByRun = new Map();
  for (const e of events) {
    if (e.kind !== 'closed') continue;
    if (!closesByRun.has(e.run)) closesByRun.set(e.run, []);
    closesByRun.get(e.run).push(e);
  }
  const shutdown = new Set();
  for (const [run, closes] of closesByRun) {
    closes.sort((a, b) => a.t - b.t);
    for (let i = 0; i < closes.length; i++) {
      const group = closes.filter(c => Math.abs(c.t - closes[i].t) <= SHUTDOWN_MS);
      const together = new Set(group.map(c => c.name)).size > 1;
      const atEnd = !live.has(run) && runEnds.has(run) && runEnds.get(run) - closes[i].t <= SHUTDOWN_MS;
      if (together || atEnd) shutdown.add(closes[i]);
    }
  }
  return events.map(e => ({ ...e, shutdown: shutdown.has(e) }));
}

/** The latest real failure of each server: server name -> event. */
export function latestFailures(marked) {
  const failures = new Map();
  for (const e of marked) if (!e.shutdown) failures.set(e.name, e);
  return failures;
}

/**
 * One row per server for a period.
 * @param {object} input
 * @param {{name, type, enabled, scope}[]} input.servers
 * @param {{tool, status, error, session_id, at, runMs}[]} input.calls  tool calls in the period
 * @param {object[]|null} input.events  marked log events, or null when they cannot be
 *   attributed (a single session is being looked at: the log does not say which session)
 */
export function computeMcpStats({ servers, calls, events, from, now }) {
  const match = createServerMatcher(servers.map(s => s.name));
  const rows = new Map(servers.map(s => [s.name, {
    name: s.name, type: s.type, enabled: s.enabled, scope: s.scope ?? 'global',
    calls: 0, errors: 0, faults: 0, totalMs: 0, timed: 0, lastUsedAt: null, sessions: new Set(), tools: new Map(),
    disconnects: events ? 0 : null, startFailures: events ? 0 : null,
  }]));

  for (const call of calls) {
    const hit = match(call.tool);
    if (!hit) continue;
    const row = rows.get(hit.server);
    row.calls++;
    row.sessions.add(call.session_id);
    if (row.lastUsedAt == null || call.at > row.lastUsedAt) row.lastUsedAt = call.at;
    if (call.runMs != null) {
      row.totalMs += call.runMs;
      row.timed++;
    }
    const tool = row.tools.get(hit.tool) ?? { tool: hit.tool, count: 0, errors: 0, faults: 0 };
    tool.count++;
    if (call.status === 'error') {
      // A server that did not answer is the server's fault; anything else is the call's.
      if (faultOf(call.error)) {
        row.faults++;
        tool.faults++;
      } else {
        row.errors++;
        tool.errors++;
      }
    }
    row.tools.set(hit.tool, tool);
  }

  for (const e of events ?? []) {
    const row = rows.get(e.name);
    if (!row || e.shutdown || e.t < from || e.t > now) continue;
    if (e.kind === 'closed') row.disconnects++;
    else row.startFailures++;
  }

  return [...rows.values()]
    .map(({ sessions, tools, timed, totalMs, ...row }) => ({
      ...row,
      avgMs: timed ? Math.round(totalMs / timed) : null,
      sessions: sessions.size,
      // Switched on, loaded into every prompt, and never called in the period.
      unused: row.enabled && row.calls === 0,
      tools: [...tools.values()].sort((a, b) => b.count - a.count).slice(0, TOP_TOOLS),
      moreTools: Math.max(0, tools.size - TOP_TOOLS),
    }))
    .sort((a, b) => Number(b.enabled) - Number(a.enabled) || b.calls - a.calls || a.name.localeCompare(b.name));
}
