// What the agent cost, by day, by month, by model and by session, and how that stands against
// a budget. The cost is OpenCode's own: what it recorded for each reply, in US dollars, from the
// price of the model in its catalogue (input, output, cache read and write, per million
// tokens). A model with no price there (a local one, most free ones) costs nothing here, and a
// subscription is counted at list price. Pure but for the source at the end: rows in, figures out.

const DAY_MS = 86_400_000;
const TOP = 10;
// A projection for the month only once this share of it has gone: a day in, it is a guess.
const PROJECT_FROM = 0.1;

const dayOf = t => new Date(t).toLocaleDateString('sv-SE');
const monthOf = t => dayOf(t).slice(0, 7);
const startOfDay = t => new Date(`${dayOf(t)}T00:00:00`).getTime();
const startOfMonth = t => new Date(`${monthOf(t)}-01T00:00:00`).getTime();
/** The start of the month `back` months before the one `t` is in. */
function monthsBack(t, back) {
  const d = new Date(startOfMonth(t));
  d.setMonth(d.getMonth() - back);
  return d.getTime();
}
const cents = n => Math.round(n * 10_000) / 10_000;
const modelOf = r => (r.provider_id ? `${r.provider_id}/${r.model_id}` : (r.model_id ?? '?'));
const tokensOf = r => (r.tokens_input ?? 0) + (r.tokens_output ?? 0) + (r.tokens_reasoning ?? 0) + (r.tokens_cache_read ?? 0) + (r.tokens_cache_write ?? 0);

function add(into, r) {
  into.cost += r.cost ?? 0;
  into.requests++;
  into.tokens += tokensOf(r);
  return into;
}
const empty = extra => ({ cost: 0, requests: 0, tokens: 0, ...extra });
const rounded = x => ({ ...x, cost: cents(x.cost) });

/** Where the budget stands for one period: spent, the limit, the share used, and its level. */
function standing(spent, limit, warnPct) {
  if (typeof limit !== 'number' || limit <= 0) return null;
  const pct = Math.round((spent / limit) * 100);
  let level = 'ok';
  if (pct >= 100) level = 'over';
  else if (pct >= warnPct) level = 'warn';
  return { limit, spent: cents(spent), pct, level };
}

/** The value under `key`, made with `make` the first time. */
function entry(map, key, make) {
  if (!map.has(key)) map.set(key, make());
  return map.get(key);
}

/** Each reply into its day and month, and this month's into its model and session. */
function tally(rows, { daily, monthly, thisMonth }) {
  const models = new Map();
  const sessions = new Map();
  for (const r of rows) {
    const day = daily.get(dayOf(r.time_created));
    if (day) add(day, r);
    const model = modelOf(r);
    const month = monthly.get(monthOf(r.time_created));
    if (month) {
      add(month, r);
      add(entry(month.models, model, () => empty({ model })), r);
    }
    if (monthOf(r.time_created) !== thisMonth) continue;
    const m = add(entry(models, model, () => empty({ model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })), r);
    m.input += r.tokens_input ?? 0;
    m.output += (r.tokens_output ?? 0) + (r.tokens_reasoning ?? 0);
    m.cacheRead += r.tokens_cache_read ?? 0;
    m.cacheWrite += r.tokens_cache_write ?? 0;
    add(entry(sessions, r.session_id, () => empty({ session_id: r.session_id })), r);
  }
  return { models, sessions };
}

/**
 * @param {object[]} rows  paid replies (db.stats.costs): session_id, time_created, provider_id,
 *   model_id, cost and tokens
 * @param {object} options
 * @param {number} options.now
 * @param {number} [options.days]    days in the daily report, ending today
 * @param {number} [options.months]  months in the monthly report, ending with this one
 * @param {{daily?: number, monthly?: number, warnPct?: number}} [options.budget]  in dollars, 0 for none
 * @param {(id: string) => {project: string, title: string}} [options.where]
 */
export function costReport(rows, { now, days = 31, months = 6, budget = {}, where = () => ({ project: '', title: '' }) }) {
  const from = Math.min(monthsBack(now, months - 1), startOfDay(now - (days - 1) * DAY_MS));
  const inRange = rows.filter(r => r.time_created >= from && r.time_created <= now && r.cost > 0);

  const daily = new Map();
  for (let i = days - 1; i >= 0; i--) {
    const date = dayOf(now - i * DAY_MS);
    daily.set(date, empty({ date }));
  }
  const monthly = new Map();
  for (let i = months - 1; i >= 0; i--) {
    const month = monthOf(monthsBack(now, i));
    monthly.set(month, empty({ month, models: new Map() }));
  }
  const thisMonth = monthOf(now);
  const { models, sessions } = tally(inRange, { daily, monthly, thisMonth });

  const today = daily.get(dayOf(now));
  const month = monthly.get(thisMonth);
  // How the month ends at the pace so far.
  const monthStart = startOfMonth(now);
  const monthEnd = monthsBack(now, -1);
  const gone = (now - monthStart) / (monthEnd - monthStart);
  const projected = gone >= PROJECT_FROM ? cents(month.cost / gone) : null;
  const warnPct = budget.warnPct ?? 80;
  const byCost = (a, b) => b.cost - a.cost;
  return {
    currency: 'USD',
    today: rounded({ cost: today.cost, requests: today.requests, tokens: today.tokens }),
    month: { ...rounded({ cost: month.cost, requests: month.requests, tokens: month.tokens }), month: thisMonth, projected },
    daily: [...daily.values()].map(rounded),
    monthly: [...monthly.values()].map(m => ({ ...rounded(m), models: [...m.models.values()].sort(byCost).slice(0, 3).map(rounded) })),
    models: [...models.values()].sort(byCost).map(rounded),
    sessions: [...sessions.values()].sort(byCost).slice(0, TOP).map(s => ({ ...rounded(s), ...where(s.session_id) })),
    budget: {
      warnPct,
      daily: standing(today.cost, budget.daily, warnPct),
      monthly: standing(month.cost, budget.monthly, warnPct),
      projected: budget.monthly > 0 && projected != null && projected > budget.monthly ? projected : null,
    },
    // Anything paid at all, ever in the report: the page shows the section only then, or with a budget.
    any: inRange.length > 0,
  };
}

/** The months the report starts at, for the query: the earliest it can need. */
export function costsFrom(now, { days = 31, months = 6 } = {}) {
  return Math.min(monthsBack(now, months - 1), startOfDay(now - (days - 1) * DAY_MS));
}

const CACHE_MS = 60_000;

/**
 * The report, read again at most once a minute: one query of the paid replies since the start
 * of the earliest month shown.
 */
export function createCostSource({ db, cfg, show = text => String(text ?? '') }) {
  let cached = { at: 0, value: null };
  return function report(now = Date.now()) {
    if (cached.value && now - cached.at < CACHE_MS) return cached.value;
    const from = costsFrom(now);
    const rows = db.stats.costs(from);
    const sessions = new Map(db.stats.sessions(from).map(s => [s.id, s]));
    const where = id => {
      const s = sessions.get(id);
      return { project: show((s?.directory ?? '').split(/[\\/]/).findLast(Boolean) ?? '', 80), title: show(s?.title ?? '', 120) };
    };
    cached = { at: now, value: costReport(rows, { now, budget: cfg.budget, where }) };
    return cached.value;
  };
}
