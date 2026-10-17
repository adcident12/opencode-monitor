// The Now tab for an assistant: every session on screen, most urgent first, with what it waits
// for, what it runs, how full its context is and whether it goes round in circles; and what
// the sessions depend on. Read off the same snapshot the page shows. Pure.
import { STATES } from './state.mjs';

const iso = t => (t == null ? null : new Date(t).toISOString());

function sessionOf(s, now) {
  const h = s.health ?? {};
  const c = h.compaction;
  return {
    id: s.id,
    parentId: s.parentId,
    title: s.title,
    project: s.project,
    model: s.model ?? null,
    state: s.state,
    reason: s.reason,
    detail: s.detail ?? null,
    since: iso(s.since),
    forMs: s.since == null ? null : Math.max(0, now - s.since),
    viaChild: s.viaChild ?? null,
    prompt: s.prompt ?? null,
    current: s.current ? { tool: s.current.tool, summary: s.current.summary, forMs: s.current.startedAt == null ? null : Math.max(0, now - s.current.startedAt) } : null,
    plan: s.progress?.todos ?? null,
    context: {
      pct: h.contextPct ?? null,
      // Room before OpenCode compacts, and roughly how many requests of the usual size fit.
      roomTokens: c?.room ?? null,
      requestsLeft: c?.requestsLeft ?? null,
      compactions: h.compactions ?? 0,
      compacting: Boolean(h.compacting),
    },
    loop: h.loop ?? null,
    hints: h.hints ?? [],
    modelProgress: s.modelProgress ?? null,
  };
}

/**
 * @param {object} snap  what the monitor read last (the page's /api/state)
 * @param {{session?: string|null}} [options]  one session, with the subagents under it
 */
export function nowView(snap, { session = null } = {}) {
  const now = snap.now;
  const rank = s => STATES.indexOf(s.state);
  let sessions = (snap.sessions ?? []).toSorted((a, b) => rank(a) - rank(b) || (a.since ?? 0) - (b.since ?? 0));
  if (session) sessions = sessions.filter(s => s.id === session || s.parentId === session);
  const env = snap.environment;
  return {
    at: iso(now),
    // Kept from the last good reading while OpenCode held its database for a moment.
    stale: Boolean(snap.stale),
    opencodeRunning: snap.opencodeRunning ?? null,
    opencodeVersion: snap.opencodeVersion ?? null,
    // A subagent's question is its parent's too: counted once, on the parent.
    needYou: sessions.filter(s => s.state === 'waiting' && !(s.parentId && sessions.some(p => p.id === s.parentId))).length,
    sessions: sessions.map(s => sessionOf(s, now)),
    environment: env
      ? {
          checkedAt: iso(env.checkedAt),
          models: env.models.map(m => ({ name: m.name, ok: m.ok, error: m.error ?? null, loaded: m.settings?.model ?? null, mismatches: m.mismatches ?? [] })),
          mcp: env.mcp.filter(m => m.status !== 'disabled').map(m => ({ name: m.name, status: m.status, kind: m.kind })),
          services: env.services.map(x => ({ name: x.name, ok: x.ok })),
        }
      : null,
  };
}
