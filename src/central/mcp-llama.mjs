// OpenCode Central, /mcp-llama on the hub (spec 5.6): the llama.cpp server on the home's model machine, answered from
// the hub's own cache (llama.mjs) so a question never sends a heavy query anywhere. Read-only: there is no tool that
// starts, stops, restarts or changes the server; changes are proposed to the owner, who makes them.

export const LLAMA_INSTRUCTIONS =
  "Figures about the user's llama.cpp model server (the one OpenCode and the home's assistants use): what it runs now (profile, model, settings, GPUs), " +
  'every change of profile, setting or llama.cpp build and every restart, its speed and prompt cache per hour, and who used it. ' +
  'Everything here is read-only: nothing can start, stop or change the server. ' +
  'To judge a change, llama_changes gives the moments and llama_compare the hours before and after; the OpenCode side (opencode_compare on the other MCP server) takes the same moment as `at`. ' +
  'Propose a setting to the user with the figure it rests on; the user changes it in Llama Stroller.';

const H = 3_600_000;
const iso = t => (t == null ? null : new Date(t).toISOString());
const round = (v, d = 1) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);
const ratio = (a, b) => (b > 0 ? a / b : null);

/** The figures of hour rows (llama.mjs), with the dashboard's formulas (lib/ai_usage.php). */
export function statsOf(rows) {
  const sum = k => rows.reduce((s, r) => s + (Number(r[k]) || 0), 0);
  const prompt = sum('prompt');
  const cached = sum('cached');
  const gen = sum('gen');
  return {
    hours: rows.length,
    workHours: rows.filter(r => (r.gen ?? 0) > 0 || (r.prompt ?? 0) > 0).length,
    promptTokens: prompt,
    cachedTokens: cached,
    genTokens: gen,
    prompt_tps: round(ratio(prompt, sum('prompt_s'))),
    gen_tps: round(ratio(gen, sum('gen_s'))),
    cached_pct: round(ratio(cached, cached + prompt) == null ? null : ratio(cached, cached + prompt) * 100),
    draft_pct: round(ratio(sum('accepted'), sum('drafts')) == null ? null : ratio(sum('accepted'), sum('drafts')) * 100),
    peak_queue: rows.reduce((m, r) => Math.max(m, Number(r.queue) || 0), 0),
    peak_busy: rows.reduce((m, r) => Math.max(m, Number(r.busy) || 0), 0),
  };
}

const NOTE = 'Per complete hour (the one going on now is not in yet). prompt_tps: prompt tokens read per second of reading; gen_tps: tokens written per second of writing; cached_pct: share of prompt tokens served from the cache; draft_pct: share of drafted (speculative) tokens accepted; peak_queue: most requests waiting for a free slot in an hour.';

/**
 * @param {ReturnType<import('./llama.mjs').createLlamaSource>} source
 * @param {{ now?: () => number }} [opts]
 */
export function buildLlamaTools(source, { now = () => Date.now() } = {}) {
  const noHours = () => {
    const st = source.hoursStatus();
    if (!st.configured) return { error: 'The hub has no InfluxDB read token for llama.cpp figures yet (central.llama.influx).' };
    if (st.until == null) return { error: `No llama.cpp figures have been read from InfluxDB yet${st.error ? `: ${st.error}` : '.'}` };
    return null;
  };
  // How fresh the hours are, and the last error when reading them failed (the figures may then be stale).
  const freshness = () => {
    const st = source.hoursStatus();
    return { figuresUntil: iso(st.until), ...(st.error ? { warning: `Reading new hours failed: ${st.error}` } : {}) };
  };
  const window = (from, to) => ({ from: iso(from), to: iso(to), ...statsOf(source.hourly(from, to)) });

  return [
    {
      name: 'llama_now',
      description: 'What the llama.cpp server runs now, as Llama Stroller reports it: running or not, healthy, the profile and its settings (model file, context size, parallel slots, flash attention, KV cache types, and every extra flag such as --spec-type, --spec-draft-n-max, --reasoning-budget, --ctx-checkpoints, --cache-ram), the llama.cpp build (number and commit, when Stroller reports it), when it started, the GPUs (memory used of total, use, temperature), and the other profiles there are. Read at most a minute ago.',
      inputSchema: { type: 'object', properties: {} },
      run: () => {
        const c = source.now();
        if (!c) return { error: 'Not read yet.' };
        return { ...c, at: iso(c.at), startedAt: iso(c.startedAt) };
      },
    },
    {
      name: 'llama_changes',
      description: 'The moments the server changed, newest first: seen (when the hub first looked), started, stopped, restart (same profile), build (a new llama.cpp build, from and to), profile (another profile; with the settings that differ), settings (the running profile\'s settings changed; they take effect at its next start). Give one of these moments to llama_compare or opencode_compare as `at`.',
      inputSchema: { type: 'object', properties: { days: { type: 'integer', minimum: 1, maximum: 180, description: 'How many days back. Default 30.' } } },
      run: ({ days } = {}) => {
        const back = Math.min(180, Math.max(1, Number.isInteger(days) ? days : 30));
        return { changes: source.events(now() - back * 86_400_000).slice().sort((a, b) => b.t - a.t).map(({ t, ...e }) => ({ at: iso(t), ...e })) };
      },
    },
    {
      name: 'llama_stats',
      description: `The server's figures for a period: prompt and written tokens, reading and writing speed, prompt cache share, draft acceptance, the most requests waiting. ${NOTE}`,
      inputSchema: { type: 'object', properties: {
        hours: { type: 'integer', minimum: 1, maximum: 4320, description: 'The last this many hours. Default 24.' },
        from: { type: 'string', description: 'Start, ISO date and time (with `to`, instead of hours).' },
        to: { type: 'string', description: 'End, ISO date and time. Default now.' },
      } },
      run: ({ hours, from, to } = {}) => {
        const missing = noHours();
        if (missing) return missing;
        const end = to ? Date.parse(to) : now();
        const start = from ? Date.parse(from) : end - (Number.isInteger(hours) ? hours : 24) * H;
        if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) return { error: 'from must be before to (ISO dates).' };
        return { ...window(start, end), ...freshness(), note: NOTE };
      },
    },
    {
      name: 'llama_compare',
      description: `What a change did on the server: the same figures for the hours before a moment and the hours after it. The hour the moment falls in belongs to neither side. By default the moment is the newest change in llama_changes. \`reliable\` is false when a side had under one hour with work. ${NOTE}`,
      inputSchema: { type: 'object', properties: {
        at: { type: 'string', description: 'The moment, ISO date and time. Default: the newest change.' },
        hours: { type: 'integer', minimum: 1, maximum: 168, description: 'How far to look each way. Default 24.' },
      } },
      run: ({ at, hours } = {}) => {
        const missing = noHours();
        if (missing) return missing;
        let moment = at ? Date.parse(at) : null;
        let event = null;
        if (moment == null) {
          const e = source.events(0).filter(x => x.kind !== 'seen').sort((a, b) => b.t - a.t)[0];
          if (!e) return { error: 'No change is recorded yet: give `at`.' };
          moment = e.t;
          event = { ...e, at: iso(e.t) };
          delete event.t;
        }
        if (!Number.isFinite(moment)) return { error: '`at` must be an ISO date and time.' };
        const span = (Number.isInteger(hours) ? hours : 24) * H;
        const cut = Math.floor(moment / H) * H;
        const before = window(cut - span, cut);
        const after = window(cut + H, Math.min(cut + H + span, now()));
        return { ...(event ? { event } : { at: iso(moment) }), before, after, reliable: before.workHours >= 1 && after.workHours >= 1, ...freshness(), note: NOTE };
      },
    },
    {
      name: 'llama_callers',
      description: 'Who used the server in the last 24 hours, as the home\'s usage page counts it: each caller (Ares chat, OpenCode from outside, MyPay receipts, the security agent, …) with requests, tokens in and out, average wait and share; and the day\'s totals.',
      inputSchema: { type: 'object', properties: {} },
      run: () => {
        if (source.usageConfigured && !source.usageConfigured()) return { error: 'No usage page is set on this hub (central.llama.usageUrl).' };
        const u = source.callers();
        if (!u) return { error: 'Not read yet.' };
        return { ...u, at: iso(u.at) };
      },
    },
  ];
}
