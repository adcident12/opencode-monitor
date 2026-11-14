// OpenCode Central, hub side: the last gate before the page and the API. The parts of a session that only make
// sense with text (what a command printed, the files touched, the steps' wording, what a prompt asks, flagged calls)
// are removed; then any filler or hash still left anywhere — in a field nobody listed — becomes null.
// filler (any length when it is all there is, or a run of 3 anywhere), a keyed hash of an input or of a path
const CONTENT = /^·+$|·{3}|^#[0-9a-f]{16}|^f:[0-9a-f]{16}$/;

function net(v) {
  if (typeof v === 'string') return CONTENT.test(v) ? null : v;
  if (Array.isArray(v)) return v.map(net);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) if (!CONTENT.test(k)) out[k] = net(x);
    return out;
  }
  return v;
}

// Shaped so the page's own components leave the parts out: an empty review is not drawn, an empty file list
// leaves only the count, a null output and a null prompt detail are skipped (dashboard guards).
function session(s) {
  const out = { ...s };
  if (out.current) out.current = { ...out.current, summary: null, output: null };
  if (out.progress?.steps) out.progress = { ...out.progress, steps: out.progress.steps.map(st => ({ ...st, text: null })) };
  if (out.work) out.work = { ...out.work, files: out.work.files ? { ...out.work.files, recent: [] } : out.work.files, running: null };
  if (out.review) out.review = { ...out.review, counts: {}, total: 0, items: [], more: 0, ignored: 0 };
  if (out.prompt) out.prompt = { ...out.prompt, detail: null };
  if (out.health?.lastError) out.health = { ...out.health, lastError: { ...out.health.lastError, text: null } };
  return out;
}

/**
 * @param {'state'|'stats'|'tasks'|'overnight'|'history'|'costs'} kind
 * @param {object} body  what the normal monitor would answer
 */
export function stripContent(kind, body) {
  if (kind === 'state' && Array.isArray(body?.sessions)) body = { ...body, sessions: body.sessions.map(session) };
  return net(body);
}
