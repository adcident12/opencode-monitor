// What happened while you were away: the night's sessions from the monitor's own record of
// state changes, each with how long it worked, how long it waited for you, and how and why
// it stopped; and how long nothing ran at all while a session needed you. Pure: the record
// in, a report out.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// States in which a session needs you: nothing moves until you act.
const NEEDS_YOU = new Set(['waiting', 'stuck', 'error']);

/**
 * The night to report: the latest stretch from `fromHour` to `toHour` (local time) that has
 * begun. Before `toHour` it is still going, and ends now.
 * @returns {{from: number, to: number, going: boolean}}
 */
export function nightOf(now, fromHour, toHour) {
  const start = new Date(now);
  start.setHours(fromHour, 0, 0, 0);
  if (start.getTime() > now) start.setDate(start.getDate() - 1);
  const end = new Date(start);
  end.setHours(toHour, 0, 0, 0);
  if (end <= start) end.setDate(end.getDate() + 1);
  return { from: start.getTime(), to: Math.min(end.getTime(), now), going: end.getTime() > now };
}

/** Each session's states over [from, to], as [{ state, start, end, event }]. */
function segmentsOf(id, before, events, from, to) {
  const segments = [];
  let current = before.get(id) ?? null;
  let start = from;
  for (const e of events) {
    if (e.id !== id) continue;
    if (current && e.t > start) segments.push({ state: current.to, start, end: e.t, event: current });
    current = e;
    start = Math.max(from, e.t);
  }
  if (current && to > start) segments.push({ state: current.to, start, end: to, event: current });
  return segments;
}

/**
 * @param {object} input
 * @param {Map<string, object>} input.before  each session's latest change before the night
 * @param {object[]} input.events             changes during the night, oldest first
 * @param {number} input.from
 * @param {number} input.to
 * @param {(id: string) => {plan: object|null, left: number}|null} [input.planOf]  from the Tasks list
 */
export function overnightOf({ before, events, from, to, going = false, planOf = () => null }) {
  // The sessions of the night: changed during it, or busy or waiting when it began.
  const ids = new Set(events.map(e => e.id));
  for (const [id, e] of before) if (e.to === 'working' || NEEDS_YOU.has(e.to)) ids.add(id);

  const sessions = [];
  const all = [];
  for (const id of ids) {
    const segments = segmentsOf(id, before, events, from, to);
    if (!segments.length) continue;
    all.push(...segments);
    const sum = state => segments.filter(s => s.state === state).reduce((n, s) => n + s.end - s.start, 0);
    const last = segments.at(-1);
    const e = last.event;
    const plan = planOf(id);
    sessions.push({
      id,
      title: e.title,
      project: e.project,
      // How it stood when the night ended, and since when.
      state: last.state,
      since: e.t,
      reason: e.reason ?? null,
      permission: e.permission ?? null,
      error: e.error ?? null,
      limitMs: e.limitMs ?? null,
      workedMs: sum('working'),
      waitedMs: sum('waiting') + sum('stuck') + sum('error'),
      plan: plan?.plan ?? null,
      left: plan?.left ?? 0,
      // Needs you now, or handed back with its plan left part done.
      unfinished: NEEDS_YOU.has(last.state) || (plan?.left ?? 0) > 0,
    });
  }

  // How long nothing ran while something waited for you: the night's lost hours.
  const edges = [...new Set(all.flatMap(s => [s.start, s.end]))].sort((a, b) => a - b);
  // In all, and the longest stretch: several short stops are not one long one.
  let stillMs = 0;
  let longest = null;
  let run = null;
  for (let i = 0; i < edges.length - 1; i++) {
    const [a, b] = [edges[i], edges[i + 1]];
    const at = s => s.start <= a && s.end >= b;
    if (!all.some(s => at(s) && s.state === 'working') && all.some(s => at(s) && NEEDS_YOU.has(s.state))) {
      stillMs += b - a;
      run = run && run.to === a ? { from: run.from, to: b } : { from: a, to: b };
      if (!longest || run.to - run.from > longest.to - longest.from) longest = run;
    }
  }

  sessions.sort((a, b) => Number(b.unfinished) - Number(a.unfinished) || b.since - a.since);
  return {
    from,
    to,
    going,
    sessions,
    totals: {
      sessions: sessions.length,
      finished: sessions.filter(s => !s.unfinished && s.state !== 'working').length,
      unfinished: sessions.filter(s => s.unfinished).length,
      working: sessions.filter(s => s.state === 'working').length,
      workedMs: sessions.reduce((n, s) => n + s.workedMs, 0),
      waitedMs: sessions.reduce((n, s) => n + s.waitedMs, 0),
      stillMs,
      longestStill: longest && { from: longest.from, to: longest.to, ms: longest.to - longest.from },
    },
  };
}

/** Whole hours and minutes, as the Discord message says them: "3 h 52 min". */
const span = ms => {
  const minutes = Math.round(ms / 60_000);
  return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`;
};
const clock = t => new Date(t).toTimeString().slice(0, 5);

/**
 * The report as lines of text, for Discord. A session's error text can hold a path, so it is
 * quoted only when details may be sent (notify.discord.includeDetail).
 */
export function overnightLines(report, t, { includeDetail = false } = {}) {
  const { totals } = report;
  if (!totals.sessions) return [t('overnight.none')];
  const lines = [t('overnight.summary', { n: totals.sessions, worked: span(totals.workedMs), finished: totals.finished, unfinished: totals.unfinished, working: totals.working })];
  const still = totals.longestStill;
  if (still && still.ms >= 10 * 60_000) lines.push(t('overnight.still', { span: span(still.ms), from: clock(still.from), to: clock(still.to) }));
  for (const s of report.sessions) {
    if (!s.unfinished) continue;
    const why = t(`reason.${s.reason}`, { permission: s.permission ?? '', limit: s.limitMs ? span(s.limitMs) : '', detail: includeDetail ? (s.error ?? '') : '' }).replace(' ()', '');
    const plan = s.plan ? ` · ${t('overnight.plan', { done: s.plan.done, total: s.plan.total })}` : '';
    lines.push(`• ${s.title || s.id} (${s.project}): ${why}, ${clock(s.since)}${plan}`);
  }
  return lines;
}

/**
 * When the report of the latest night falls due, if it does now: once that night has ended,
 * until the next one begins (a monitor started at noon still sends the morning's), and once.
 */
export function morningDue({ now, from, to, lastSent = 0 }) {
  const night = nightOf(now, from, to);
  if (night.going) return null;
  return lastSent < night.to ? night.to : null;
}

/**
 * The report of the latest night, and its Discord message when the night ends.
 * @param {object} deps
 * @param {object} deps.cfg      full config (overnight, notify)
 * @param {object} deps.history  from createHistory
 * @param {(days: number) => object} deps.tasks  from createTasksSource
 * @param {Function} [deps.send] notifier.send
 * @param {string|null} [deps.stateFile]  remembers the last morning sent
 */
export function createOvernight({ cfg, history, tasks, send = null, t = null, stateFile = null, read = readFileSync, write = writeFileSync }) {
  let lastSent = 0;
  if (stateFile) {
    try {
      lastSent = Number(JSON.parse(read(stateFile, 'utf8')).lastSent) || 0;
    } catch {
      // never sent, or a broken file: both mean "nothing sent yet"
    }
  }
  let checkedAt = -Infinity;

  function report(now = Date.now()) {
    const night = nightOf(now, cfg.overnight.from, cfg.overnight.to);
    const { before, events } = history.between(night.from, night.to);
    const plans = new Map(tasks(7).projects.flatMap(p => p.sessions).map(s => [s.id, { plan: s.plan, left: s.left.length + s.more }]));
    return { ...overnightOf({ ...night, before, events, planOf: id => plans.get(id) ?? null }), recorded: cfg.history.enabled };
  }

  function check(now = Date.now()) {
    if (!send || !cfg.notify.overnight?.enabled || !cfg.notify.discord.webhookUrl || now - checkedAt < 60_000) return false;
    checkedAt = now;
    const due = morningDue({ now, from: cfg.overnight.from, to: cfg.overnight.to, lastSent });
    if (due == null) return false;
    // Marked first: a report that fails to build must not be retried every minute.
    lastSent = due;
    if (stateFile) {
      try {
        mkdirSync(dirname(stateFile), { recursive: true });
        write(stateFile, JSON.stringify({ lastSent }));
      } catch (err) {
        console.warn(`Could not write ${stateFile}: ${err.code ?? err.message}`);
      }
    }
    try {
      send('overnight', t('notify.overnight'), overnightLines(report(due), t, { includeDetail: cfg.notify.discord.includeDetail }), now, '', { desktop: false });
    } catch (err) {
      console.warn(`Overnight report failed: ${err.code ?? err.message}`);
    }
    return true;
  }

  return { report, check };
}
