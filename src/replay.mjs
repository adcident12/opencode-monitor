// Everything needed to play one session back: what each agent was doing from moment to
// moment, when it waited for you, how its context filled, and how its plan went. Pure: rows
// from the database and the log in, one object out; the page does the playing.
//
// Read from OpenCode's own records, with the same rules as the Now tab and Stats, so a session
// can be played back even if the monitor was not running at the time.
import { matchPrompts } from './stats.mjs';
import { endingOf, turnsOfSession } from './work.mjs';

/** Subagent rows shown at most; the rest are counted. */
const MAX_SUBAGENTS = 7;

const startOf = p => p.started ?? p.time_created;
const tokensSent = m => (m.tokens_input ?? 0) + (m.tokens_cache_read ?? 0) + (m.tokens_cache_write ?? 0);
const describe = p => p.cmd ?? p.file ?? p.question ?? p.descr ?? '';

/**
 * One row: the segments of one session, oldest first, as [start, end, kind, detail].
 * kind: reading (the model reading the prompt before its first token), thinking, writing,
 * tool, compact, waiting (for you). Segments may overlap: a tool waits while a prompt is open.
 */
function segmentsOf({ messages, tools, spans, steps, prompts, now, show }) {
  const segs = [
    ...messages.filter(m => m.role === 'assistant').map(m => replySegment(m, steps, now)).filter(Boolean),
    ...spans.filter(s => s.s != null && s.e != null && s.e > s.s).map(s => [s.s, s.e, s.type === 'reasoning' ? 'thinking' : 'writing', '']),
    ...tools.map(p => toolSegment(p, now, show)),
    ...prompts.map(w => waitSegment(w, now, show)),
  ];
  return segs.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
}

/** A reply: compacting when it is OpenCode's summary, else the model reading before its first token. */
function replySegment(m, steps, now) {
  if (m.agent === 'compaction' || m.summary) return [m.time_created, m.completed ?? now, 'compact', ''];
  const first = steps.get(m.id)?.first_token;
  return first != null && first > m.time_created ? [m.time_created, first, 'reading', ''] : null;
}

/** A tool call, until it ended; one still running lasts until now. */
function toolSegment(p, now, show) {
  const running = p.status === 'running' || p.status === 'pending';
  const end = p.ended ?? (running ? now : p.time_updated);
  return [startOf(p), Math.max(startOf(p), end), 'tool', show(`${p.tool} ${describe(p)}`.trim(), 160)];
}

/** A prompt waiting for you, until it was answered, or left. */
function waitSegment(w, now, show) {
  const end = w.answeredAt ?? w.abandonedAt ?? now;
  const what = w.kind === 'question' ? (w.part?.question ?? '') : `${w.permission ?? ''} ${w.patterns ?? ''}`.trim();
  return [w.t, Math.max(w.t, end), 'waiting', show(what, 160)];
}

/** Each prompt you wrote in the session, when its last reply ended, and how. */
function turnsIn(messages, now) {
  return turnsOfSession([...messages]).map(turn => {
    const last = turn.replies.at(-1);
    return { at: turn.at, end: last ? (last.completed ?? last.time_created) : turn.at, ending: endingOf(last, now, turn.followed) };
  });
}

/** Every list the agent wrote, as [time, [[text, status], ...]], oldest first. */
function plansIn(todoWrites, show) {
  const plans = [];
  for (const call of [...todoWrites].sort((a, b) => a.time_created - b.time_created)) {
    let list;
    try {
      list = JSON.parse(call.todos ?? '[]');
    } catch {
      continue;
    }
    if (!Array.isArray(list)) continue;
    plans.push([call.time_created, list.filter(i => i && typeof i.content === 'string').map(i => [show(i.content, 160), String(i.status ?? 'pending')])]);
  }
  return plans;
}

/**
 * @param {object} input
 * @param {object[]} input.tree   the session and every session under it, the session first
 * @param {object[]} input.allTools  tool calls of every session in the same hours: a prompt
 *   is matched against all of them, so it is never pinned on this session by mistake
 */
export function buildReplay({ tree, messages, tools, allTools = tools, spans, steps, compactions, todoWrites, asks, replies, eventTimes, now, stuckMs, show, contextLimit = () => null, compactAt = () => null }) {
  const root = tree[0];
  if (!root) return null;
  const ids = new Set(tree.map(s => s.id));
  const by = (list, id) => list.filter(x => x.session_id === id);

  const prompts = matchPrompts({ asks, replies, tools: allTools, eventTimes, now }).filter(p => p.part && ids.has(p.part.session_id));
  const spansBy = new Map();
  for (const s of spans) {
    if (!spansBy.has(s.session_id)) spansBy.set(s.session_id, []);
    spansBy.get(s.session_id).push(s);
  }
  const rowFor = session => {
    const own = by(messages, session.id);
    const agent = own.find(m => m.role === 'assistant' && m.agent && m.agent !== 'compaction')?.agent ?? null;
    return {
      id: session.id,
      // A subagent is named by its agent; its title (often long) is for the tooltip.
      name: show(agent ?? (session.parent_id ? 'subagent' : 'agent'), 40),
      title: show(session.title ?? '', 200),
      sub: session.id !== root.id,
      segs: segmentsOf({ messages: own, tools: by(tools, session.id), spans: spansBy.get(session.id) ?? [], steps, prompts: prompts.filter(p => p.part.session_id === session.id), now, show }),
    };
  };
  const children = tree.slice(1).sort((a, b) => a.time_created - b.time_created);
  const rows = [rowFor(root), ...children.slice(0, MAX_SUBAGENTS).map(rowFor)];

  // The context of each of the session's own requests, against the model it used last.
  const requests = by(messages, root.id).filter(m => m.role === 'assistant' && !m.summary && tokensSent(m) > 0).sort((a, b) => a.time_created - b.time_created);
  const lastModel = requests.at(-1);
  const times = rows.flatMap(r => r.segs.flatMap(s => [s[0], s[1]]));
  const start = Math.min(root.time_created, ...times);
  const end = Math.max(root.time_updated ?? root.time_created, ...times);
  // Dir names are the project's: the folder only, as on the cards.
  const project = show(String(root.directory ?? '').split(/[\\/]/).findLast(Boolean) ?? '', 80);

  return {
    session: { id: root.id, title: show(root.title ?? '', 200), project },
    start,
    end,
    now,
    stuckMs,
    rows,
    moreSubagents: Math.max(0, children.length - MAX_SUBAGENTS),
    turns: turnsIn(by(messages, root.id), now),
    context: requests.map(m => [m.time_created, tokensSent(m)]),
    contextLimit: lastModel ? contextLimit(lastModel.provider_id, lastModel.model_id) : null,
    compactAt: lastModel ? compactAt(lastModel.provider_id, lastModel.model_id, root.directory) : null,
    compactions: by(compactions, root.id).map(c => c.time_created).sort((a, b) => a - b),
    plans: plansIn(by(todoWrites, root.id), show),
  };
}
