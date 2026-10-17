// An agent going round in circles: the same calls over and over, one tool failing again and
// again, or hours of work while its plan does not move. Read off a session's tool calls in
// order, the same way for a session at work now (the Now tab, a notification) and for a
// period (Stats). Pure: calls in, episodes out.
//
// The limits were set against a month of real sessions on this machine (54 sessions, 9,789
// calls). A file read again after an edit, or a page snapshot taken up to seven times in a
// row while it loads, is how agents work and is not told; each limit is past what ordinary
// work there reached. What they caught there: a tool that failed four times in a row, twice,
// and plans that stood still for over an hour of work.

export const LIMITS = {
  // The same call this many times back to back.
  repeatOne: 8,
  // The same two or three calls in the same order this many times back to back.
  repeatBlock: 6,
  maxBlock: 3,
  // One tool's calls failing this many times with no success of it in between.
  failing: 4,
  // A failure streak is still going on while its last failure is among the last calls.
  failingRecent: 5,
  // This long at work, and this many calls, since the plan last changed, with items open.
  stalledMs: 60 * 60_000,
  stalledCalls: 30,
  // A pause between two calls counts as work up to this long (the model reading or thinking).
  gapMs: 10 * 60_000,
};

const DONE = new Set(['completed', 'cancelled']);
const keyOf = c => `${c.tool}|${c.input_len ?? ''}|${c.input ?? ''}`;
const timeOf = c => c.started ?? c.time_created;

/** The plan a todowrite call wrote, or null when it cannot be read. */
function planOf(call) {
  try {
    const todos = call.todos ? JSON.parse(call.todos) : JSON.parse(call.input ?? 'null')?.todos;
    return Array.isArray(todos) ? todos : null;
  } catch {
    return null;
  }
}

/**
 * How many times the last `per` calls up to `i` repeat back to back, ending at `i`. A block
 * that is itself one call repeated is left to the shorter period.
 */
function repeatsAt(keys, i, per) {
  if (i + 1 < per) return 0;
  const block = keys.slice(i - per + 1, i + 1);
  if (per > 1 && block.every(k => k === block[0])) return 0;
  let times = 1;
  for (;;) {
    const start = i - (times + 1) * per + 1;
    if (start < 0 || !block.every((k, j) => keys[start + j] === k)) return times;
    times++;
  }
}

/** The repetition that holds at call `i`, if one is past its limit: the shortest first. */
function repetitionAt(keys, i, limits) {
  for (let per = 1; per <= limits.maxBlock; per++) {
    const times = repeatsAt(keys, i, per);
    if (times >= (per === 1 ? limits.repeatOne : limits.repeatBlock)) return { per, times };
  }
  return null;
}

/**
 * An OpenCode 2 `execute` script that called tools is one turn of the agent's, however many
 * calls it made: each tool in it counts once, failed when every call of it there failed. A
 * script that looped is the script's doing (Stats says so as script_loop), not the agent going
 * round in circles; a tool that fails script after script still is.
 */
function oneCallPerScript(calls) {
  const seen = new Map(); // "script|tool" -> [its first call, all failed so far]
  for (const c of calls) {
    if (!c.script) continue;
    const key = `${c.script}|${c.tool}`;
    const s = seen.get(key);
    if (s) s[1] &&= c.status === 'error';
    else seen.set(key, [c, c.status === 'error']);
  }
  if (!seen.size) return calls;
  return calls.flatMap(c => {
    if (!c.script) return [c];
    const [first, failed] = seen.get(`${c.script}|${c.tool}`);
    return c === first ? [{ ...c, status: failed ? 'error' : 'completed' }] : [];
  });
}

/**
 * @param {object[]} calls  one session's finished tool calls, oldest first: tool, input,
 *   input_len, status, error, started or time_created, id, and for todowrite its todos
 * @returns {{ episodes: object[], now: object|null }} every episode, oldest first; `now`
 *   the one still going on at the last call, if any
 */
export function loopsOf(calls, limits = LIMITS) {
  calls = oneCallPerScript(calls);
  const episodes = [];
  const trackers = [repetitionTracker(calls, limits, episodes), failureTracker(limits, episodes), planTracker(limits, episodes)];
  calls.forEach((call, i) => {
    for (const tracker of trackers) tracker.step(call, i, timeOf(call));
  });
  const end = calls.length - 1;
  const going = trackers.map(tracker => tracker.going(end)).filter(Boolean);
  for (const e of episodes) e.ongoing = going.includes(e);
  return { episodes, now: going[0] ?? null };
}

// The same calls again, back to back.
function repetitionTracker(calls, limits, episodes) {
  const keys = calls.map(keyOf);
  let open = null;
  return {
    step(call, i, t) {
      const rep = repetitionAt(keys, i, limits);
      if (!rep) return;
      if (open?.per === rep.per && open.last === i - 1) {
        Object.assign(open, { times: rep.times, last: i, to: t });
        return;
      }
      // One call failing over and over is told as failing, not twice.
      const failingAlready = rep.per === 1 && call.status === 'error' && rep.times > limits.failing;
      if (failingAlready) return;
      const first = calls[i - rep.per * rep.times + 1];
      open = { kind: 'repeating', id: `repeating:${first.id}`, per: rep.per, times: rep.times, tools: calls.slice(i - rep.per + 1, i + 1).map(c => c.tool), call, at: timeOf(first), to: t, last: i };
      episodes.push(open);
    },
    going: end => (open?.last === end ? open : null),
  };
}

// One tool failing again and again, whatever else ran in between.
function failureTracker(limits, episodes) {
  const streaks = new Map(); // tool -> { count, first, last, episode }
  return {
    step(call, i, t) {
      if (call.status !== 'error') {
        streaks.delete(call.tool);
        return;
      }
      const s = streaks.get(call.tool) ?? { count: 0, first: call, episode: null };
      s.count++;
      s.last = i;
      streaks.set(call.tool, s);
      if (s.episode) Object.assign(s.episode, { times: s.count, error: call.error ?? null, call, to: t, last: i });
      else if (s.count >= limits.failing) {
        s.episode = { kind: 'failing', id: `failing:${s.first.id}`, tool: call.tool, times: s.count, error: call.error ?? null, call, at: timeOf(s.first), to: t, last: i };
        episodes.push(s.episode);
      }
    },
    going: end => [...streaks.values()].find(s => s.episode && end - s.last < limits.failingRecent)?.episode ?? null,
  };
}

// Work while the plan stands still: time and calls since it last changed, with items open.
function planTracker(limits, episodes) {
  // sig: the plan as text, to see when it changed; none written yet is the empty one.
  let plan = { sig: '', open: 0, workMs: 0, calls: 0, since: null, episode: null };
  let prevT = null;
  return {
    step(call, i, t) {
      plan.workMs += prevT == null ? 0 : Math.min(Math.max(0, t - prevT), limits.gapMs);
      prevT = t;
      const todos = call.tool === 'todowrite' && call.status === 'completed' ? planOf(call) : null;
      const sig = todos ? todos.map(x => `${x.content}\u0000${x.status}`).join('\u0001') : plan.sig;
      if (sig !== plan.sig) {
        plan = { sig, open: todos.filter(x => !DONE.has(x.status)).length, workMs: 0, calls: 0, since: t, episode: null };
        return;
      }
      if (!plan.open) return;
      plan.calls++;
      if (plan.episode) Object.assign(plan.episode, { workMs: plan.workMs, calls: plan.calls, to: t, last: i });
      else if (plan.workMs >= limits.stalledMs && plan.calls >= limits.stalledCalls) {
        plan.episode = { kind: 'plan_stalled', id: `plan_stalled:${call.id}`, workMs: plan.workMs, calls: plan.calls, open: plan.open, since: plan.since, at: t, to: t, last: i };
        episodes.push(plan.episode);
      }
    },
    going: () => plan.episode,
  };
}

/**
 * Every episode of a period, newest first, from the tool calls started in it. Plans come from
 * the todo lists written (a todowrite call's own input may be cut short in the tool rows).
 * `ongoing`: still so at the session's last finished call, and the session did something a
 * moment ago (a call still running counts).
 * @returns {{ count: number, byKind: Record<string, number>, episodes: object[] }}
 */
export function loopsInPeriod({ tools, todoWrites, from, now, inScope = () => true, limits = LIMITS }) {
  const bySession = new Map();
  const lastAt = new Map(); // session -> its latest call, running or not
  for (const p of tools) lastAt.set(p.session_id, Math.max(lastAt.get(p.session_id) ?? 0, timeOf(p)));
  const add = (sessionId, call) => {
    if (!inScope(sessionId)) return;
    if (!bySession.has(sessionId)) bySession.set(sessionId, []);
    bySession.get(sessionId).push(call);
  };
  for (const p of tools) if (p.tool !== 'todowrite' && p.status !== 'running' && p.status !== 'pending') add(p.session_id, p);
  for (const w of todoWrites) add(w.session_id, { id: `todo:${w.time_created}`, tool: 'todowrite', status: 'completed', todos: w.todos, time_created: w.time_created });

  const episodes = [];
  for (const [sessionId, calls] of bySession) {
    calls.sort((a, b) => timeOf(a) - timeOf(b));
    const recent = now - Math.max(lastAt.get(sessionId) ?? 0, timeOf(calls.at(-1))) < limits.gapMs;
    for (const e of loopsOf(calls, limits).episodes) {
      if (e.at < from) continue;
      episodes.push({ ...e, session_id: sessionId, ongoing: e.ongoing && recent });
    }
  }
  const byKind = {};
  for (const e of episodes) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
  return { count: episodes.length, byKind, episodes: episodes.toSorted((a, b) => b.at - a.at) };
}

/** A tool call that has finished, as the loop reading takes it. */
export const finished = p => p.type === 'tool' && p.status !== 'running' && p.status !== 'pending';
