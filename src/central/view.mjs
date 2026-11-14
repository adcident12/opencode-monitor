// OpenCode Central, hub side: the last gate before the page and the API. The parts of a session that only make
// sense with text (what a command printed, the files touched, the steps' wording, what a prompt asks, flagged calls)
// are removed; then any filler or hash still left anywhere — in a field nobody listed — becomes null.
const CONTENT = /·{3}|^#[0-9a-f]{16}|^f:[0-9a-f]{16}$/;

function net(v) {
  if (typeof v === 'string') return CONTENT.test(v) ? null : v;
  if (Array.isArray(v)) return v.map(net);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = net(x);
    return out;
  }
  return v;
}

function session(s) {
  const out = { ...s };
  if (out.current) { const { summary, output, ...rest } = out.current; out.current = rest; }
  if (out.progress?.steps) out.progress = { ...out.progress, steps: out.progress.steps.map(({ text, ...rest }) => rest) };
  if (out.work) {
    const files = out.work.files ? (({ recent, ...rest }) => rest)(out.work.files) : out.work.files;
    out.work = { ...out.work, files, running: null };
  }
  if (out.review) out.review = { ...out.review, items: [] };
  if (out.prompt) out.prompt = { ...out.prompt, detail: null };
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
