// OpenCode Central, the llama.cpp side (spec 5.4, 5.6). The hub keeps, for its MCP door /mcp-llama:
//   - what the model server runs now, from Llama Stroller (GET /api/status and /api/profiles only, every poll);
//   - the moments that changed (first seen, started, stopped, a restart, another profile, a changed setting),
//     appended to llama-events.jsonl;
//   - its figures per hour from InfluxDB (the llama.cpp counters Telegraf collects): 7 days back on the first poll,
//     then only the complete hours not yet asked, one small query; kept in llama-hourly.jsonl (180 days);
//   - who used it, from the home's usage page (?api=ai_usage), at most every 5 minutes.
// Only the hub's own files are written. Paths become their last part, key files and addresses are left out.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const H = 3_600_000;
const DAY = 86_400_000;
const BACKFILL = 7 * DAY;
const KEEP = 180 * DAY;
const USAGE_EVERY = 5 * 60_000;

// InfluxDB field → hour-row key. Counters are summed per hour, gauges are the hour's highest.
const COUNTERS = {
  'llamacpp:prompt_tokens_total': 'prompt', 'llamacpp:prompt_seconds_total': 'prompt_s', 'llamacpp:prompt_tokens_cached_total': 'cached',
  'llamacpp:tokens_predicted_total': 'gen', 'llamacpp:tokens_predicted_seconds_total': 'gen_s',
  'llamacpp:spec_decode_num_draft_tokens_total': 'drafts', 'llamacpp:spec_decode_num_accepted_tokens_total': 'accepted',
};
const GAUGES = { 'llamacpp:requests_deferred': 'queue', 'llamacpp:requests_processing': 'busy' };
const KEYS = [...Object.values(COUNTERS), ...Object.values(GAUGES)];

const base = v => String(v).split(/[\\/]/).filter(Boolean).pop() ?? '';
const looksLikePath = v => typeof v === 'string' && /[\\/]/.test(v);

/** A profile's settings by name: the model file's name, the numbers, every extra flag; no key file, path or address. */
export function sanitizeProfile(p) {
  if (!p || typeof p !== 'object') return null;
  const args = {};
  const words = String(p.extraArgs ?? '').trim().split(/\s+/).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (!w.startsWith('-')) continue;
    const next = words[i + 1];
    const hasValue = next != null && (!next.startsWith('-') || /^-\d/.test(next));
    if (hasValue) i++;
    if (/^--?api-key/i.test(w)) continue;
    args[w] = hasValue ? (looksLikePath(next) ? base(next) : next) : true;
  }
  const out = { name: String(p.name ?? '').slice(0, 80), model: p.model ? base(p.model) : null };
  for (const k of ['ctxSize', 'gpuLayers', 'parallel', 'flashAttn', 'cacheTypeK', 'cacheTypeV']) out[k] = p[k] ?? null;
  out.args = args;
  if (typeof p.note === 'string' && p.note) out.note = p.note.slice(0, 300);
  return out;
}

/** InfluxDB's CSV answer (one or more tables) → [{time, field, value}]. */
export function parseFluxCsv(text) {
  const out = [];
  let cols = null;
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) { cols = null; continue; }
    const cells = line.split(',');
    if (!cols) { cols = { time: cells.indexOf('_time'), field: cells.indexOf('_field'), value: cells.indexOf('_value') }; continue; }
    const value = Number(cells[cols.value]);
    const time = Date.parse(cells[cols.time]);
    if (Number.isFinite(value) && Number.isFinite(time)) out.push({ time, field: cells[cols.field], value });
  }
  return out;
}

function hoursFlux(bucket, start, stop) {
  const range = `from(bucket: ${JSON.stringify(bucket)}) |> range(start: ${new Date(start).toISOString()}, stop: ${new Date(stop).toISOString()}) |> filter(fn: (r) => r._measurement == "llamacpp")`;
  const set = names => `[${names.map(n => JSON.stringify(n)).join(', ')}]`;
  // Same shape as the dashboard's lib/ai_usage.php: a counter's difference per series first (a restart resets it and
  // the negative step is dropped), summed per hour; then added up over the series.
  return `counters = ${range}
  |> filter(fn: (r) => contains(value: r._field, set: ${set(Object.keys(COUNTERS))}))
  |> difference(nonNegative: true) |> aggregateWindow(every: 1h, fn: sum, createEmpty: false) |> toFloat()
  |> group(columns: ["_field", "_time"]) |> sum() |> group()
gauges = ${range}
  |> filter(fn: (r) => contains(value: r._field, set: ${set(Object.keys(GAUGES))}))
  |> aggregateWindow(every: 1h, fn: max, createEmpty: false) |> toFloat()
  |> group(columns: ["_field", "_time"]) |> max() |> group()
union(tables: [counters, gauges]) |> keep(columns: ["_time", "_field", "_value"])`;
}

const readLines = path => {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
};
const writeLines = (path, rows) => { writeFileSync(`${path}.tmp`, rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '')); renameSync(`${path}.tmp`, path); };
const readJson = (path, fallback) => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; } };

function flatten(settings) {
  const out = {};
  for (const [k, v] of Object.entries(settings ?? {})) {
    if (k === 'name' || k === 'note') continue;
    if (k === 'args') for (const [a, x] of Object.entries(v)) out[`args.${a}`] = x;
    else out[k] = v;
  }
  return out;
}

function changesOf(before, after) {
  const a = flatten(before);
  const b = flatten(after);
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(k => a[k] !== b[k]).map(k => ({ key: k, from: a[k] ?? null, to: b[k] ?? null }));
}

/**
 * @param {object} o
 * @param {string} o.dir  the hub's own folder for these files
 * @param {string} o.stroller  e.g. http://192.168.0.53:4570
 * @param {{url: string, org: string, bucket: string, token: string}|null} o.influx  a read-only token
 * @param {string|null} o.usageUrl  the home's ?api=ai_usage
 */
export function createLlamaSource({ dir, stroller, influx = null, usageUrl = null, fetch = globalThis.fetch, now = Date.now }) {
  mkdirSync(dir, { recursive: true });
  const eventsFile = join(dir, 'llama-events.jsonl');
  const hourlyFile = join(dir, 'llama-hourly.jsonl');
  const stateFile = join(dir, 'llama-state.json');
  const keepFrom = () => now() - KEEP;

  let events = readLines(eventsFile).filter(e => e.t >= keepFrom());
  const hours = new Map(readLines(hourlyFile).filter(r => r.t >= keepFrom()).map(r => [r.t, r]));
  let state = readJson(stateFile, null); // {running, profile, startedAt, settings, doneUntil}
  let current = null;
  let usage = null;
  let usageAt = -Infinity;

  const saveState = () => { writeFileSync(`${stateFile}.tmp`, JSON.stringify(state)); renameSync(`${stateFile}.tmp`, stateFile); };
  const record = e => { events.push(e); appendFileSync(eventsFile, `${JSON.stringify(e)}\n`); };
  const get = async url => {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  };

  async function pollStroller() {
    let status;
    let profiles;
    try {
      [status, profiles] = await Promise.all([get(`${stroller}/api/status`), get(`${stroller}/api/profiles`)]);
    } catch (err) {
      current = { at: now(), error: `Llama Stroller is not reachable (${String(err?.message ?? err).slice(0, 80)}).` };
      return;
    }
    const list = (profiles?.profiles ?? []).map(sanitizeProfile).filter(Boolean);
    const running = status?.running === true;
    const profile = running ? String(status.profile ?? '') || null : null;
    const settings = list.find(p => p.name === profile) ?? null;
    const startedAt = running && status.startedAt ? Date.parse(status.startedAt) || null : null;
    current = {
      at: now(), running, healthy: status?.healthy === true, loading: status?.loading === true, profile, startedAt,
      gpu: (status?.gpu ?? []).map(g => ({ index: g.index, name: g.name, memTotalMiB: g.memTotalMiB, memUsedMiB: g.memUsedMiB, utilPct: g.utilPct, tempC: g.tempC })),
      settings, profiles: list.map(p => p.name),
    };
    const t = now();
    const was = state;
    if (!was || !('running' in was)) record({ t, kind: 'seen', profile, running });
    else if (was.running && !running) record({ t, kind: 'stopped', profile: was.profile });
    else if (!was.running && running) record({ t, kind: 'started', profile });
    else if (running && was.profile !== profile) record({ t, kind: 'profile', profile, from: was.profile, to: profile, changes: changesOf(was.settings, settings) });
    else if (running && was.startedAt !== startedAt) record({ t, kind: 'restart', profile });
    else if (running && JSON.stringify(flatten(was.settings)) !== JSON.stringify(flatten(settings))) record({ t, kind: 'settings', profile, changes: changesOf(was.settings, settings) });
    state = { ...(was ?? {}), running, profile, startedAt, settings };
    saveState();
  }

  async function pollHours() {
    if (!influx?.url || !influx.token) return;
    const lastHour = Math.floor(now() / H) * H; // the hour going on now is not complete
    const newest = Math.max(state?.doneUntil ?? -Infinity, ...[...hours.keys()].map(t => t + H));
    const from = Math.max(Number.isFinite(newest) ? newest : -Infinity, lastHour - BACKFILL);
    if (from >= lastHour) return;
    const res = await fetch(`${influx.url.replace(/\/+$/, '')}/api/v2/query?org=${encodeURIComponent(influx.org)}`, {
      method: 'POST',
      headers: { Authorization: `Token ${influx.token}`, 'Content-Type': 'application/vnd.flux', Accept: 'application/csv' },
      body: hoursFlux(influx.bucket, from, lastHour),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`InfluxDB answered ${res.status}`);
    const fields = { ...COUNTERS, ...GAUGES };
    for (const { time, field, value } of parseFluxCsv(await res.text())) {
      const key = fields[field];
      if (!key) continue;
      const t = time - H; // aggregateWindow stamps the end of the hour
      const row = hours.get(t) ?? Object.fromEntries([['t', t], ...KEYS.map(k => [k, 0])]);
      row[key] = value;
      hours.set(t, row);
    }
    for (const t of hours.keys()) if (t < keepFrom()) hours.delete(t);
    writeLines(hourlyFile, [...hours.values()].sort((a, b) => a.t - b.t));
    state = { ...(state ?? {}), doneUntil: lastHour };
    saveState();
  }

  async function pollUsage() {
    if (!usageUrl || now() - usageAt < USAGE_EVERY) return;
    usageAt = now();
    try {
      const u = await get(usageUrl);
      usage = { at: now(), d1: u?.d1 ?? null, callers: Array.isArray(u?.callers) ? u.callers : [] };
    } catch (err) {
      usage = { at: now(), error: `The usage page is not reachable (${String(err?.message ?? err).slice(0, 80)}).` };
    }
  }

  let hoursError = null;
  return {
    async poll() {
      await pollStroller();
      try { await pollHours(); hoursError = null; } catch (err) { hoursError = String(err?.message ?? err).slice(0, 120); }
      await pollUsage();
      if (events.length && events[0].t < keepFrom()) { events = events.filter(e => e.t >= keepFrom()); writeLines(eventsFile, events); }
    },
    now: () => current,
    events: (since = 0) => events.filter(e => e.t >= since),
    /** Hour rows with from <= t < to, oldest first. */
    hourly: (from, to) => [...hours.values()].filter(r => r.t >= from && r.t < to).sort((a, b) => a.t - b.t),
    hoursStatus: () => ({ configured: Boolean(influx?.url && influx?.token), error: hoursError, until: state?.doneUntil ?? null }),
    callers: () => usage,
  };
}
