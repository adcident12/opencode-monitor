// OpenCode Central, hub side: the key figures of every applied batch as InfluxDB line protocol, written to the home's
// InfluxDB (bucket "opencode") so Grafana, alerts, Ares and the dashboard can read them beside llama.cpp's. Points
// carry only numbers, statuses and names; their time is the event's own. A row sent twice writes the same point
// (same series and time), which InfluxDB keeps once.
import { createHash } from 'node:crypto';

const RENAMED = { shell: 'bash', subagent: 'task' }; // OpenCode 2 tool names, as src/db-v2.mjs maps them
const NAME = /^[\w.@/:+-]{1,200}$/;

export const escapeTag = v => String(v).replace(/[,= ]/g, c => `\\${c}`);
const tag = v => (typeof v === 'string' && v && NAME.test(v.replace(/[ ,=]/g, '_')) ? escapeTag(v) : 'unknown');
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const parse = s => { try { const d = JSON.parse(s); return d && typeof d === 'object' ? d : {}; } catch { return {}; } };

/**
 * A point's time in ns: the event's ms, nudged inside that ms by a hash of the row it came from. Two calls that end
 * in the same ms stay two points; the same row sent again lands on the same point.
 */
function ns(ms, id) {
  const nudge = id == null ? 0 : parseInt(createHash('sha1').update(String(id)).digest('hex').slice(0, 8), 16) % 1_000_000;
  return BigInt(Math.round(ms)) * 1_000_000n + BigInt(nudge);
}

function line(measurement, tags, fields, t, id = null) {
  const f = Object.entries(fields).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${v}`);
  if (!f.length || !Number.isFinite(t)) return null;
  return `${measurement},${Object.entries(tags).map(([k, v]) => `${k}=${tag(v)}`).join(',')} ${f.join(',')} ${ns(t, id)}`;
}

const tokenFields = (tok, cost) => ({
  tokens_in: num(tok?.input), tokens_out: num(tok?.output), reasoning: num(tok?.reasoning),
  cache_read: num(tok?.cache?.read), cache_write: num(tok?.cache?.write), cost: num(cost),
});

/**
 * @param {{ rows: Record<string, object[]> }} batch  as applied to the store (already content-free)
 * @param {string} machine
 * @param {{ projectOf: (sessionId: string) => string|null, modelOf: (messageId: string) => {providerID, modelID}|null }} lookup
 * @returns {string[]}
 */
export function toLines(batch, machine, { projectOf, modelOf }) {
  const out = [];
  const push = l => { if (l) out.push(l); };
  for (const p of batch?.rows?.part ?? []) {
    const d = parse(p.data);
    const project = projectOf(p.session_id);
    if (d.type === 'step-finish') {
      const m = modelOf(p.message_id);
      push(line('opencode_request', { machine, project, provider: m?.providerID, model: m?.modelID }, tokenFields(d.tokens, d.cost), p.time_created, p.id));
    } else if (d.type === 'tool') {
      const st = d.state ?? {};
      const start = num(st.time?.start);
      const end = num(st.time?.end);
      if ((st.status === 'completed' || st.status === 'error') && start !== undefined && end !== undefined) {
        push(line('opencode_tool', { machine, project, tool: d.tool, status: st.status }, { duration_ms: end - start }, end, p.id));
      }
    } else if (d.type === 'compaction') {
      push(line('opencode_compaction', { machine, project, auto: String(!!d.auto) }, { n: 1 }, p.time_created, p.id));
    }
  }
  for (const r of batch?.rows?.session_message ?? []) {
    const d = parse(r.data);
    const project = projectOf(r.session_id);
    if (r.type === 'assistant') {
      const created = num(d.time?.created) ?? r.time_created;
      const completed = num(d.time?.completed);
      if (d.tokens) {
        push(line('opencode_request', { machine, project, provider: d.model?.providerID, model: d.model?.id },
          { ...tokenFields(d.tokens, d.cost), duration_ms: completed !== undefined ? completed - created : undefined }, created, r.id));
      }
      for (const [i, item] of (Array.isArray(d.content) ? d.content : []).entries()) {
        if (item?.type !== 'tool') continue;
        const status = item.state?.status;
        const start = num(item.time?.ran) ?? num(item.time?.created);
        const end = num(item.time?.completed);
        if ((status === 'completed' || status === 'error') && start !== undefined && end !== undefined) {
          push(line('opencode_tool', { machine, project, tool: RENAMED[item.name] ?? item.name, status }, { duration_ms: end - start }, end, item.id ?? `${r.id}:${i}`));
        }
      }
    } else if (r.type === 'compaction') {
      push(line('opencode_compaction', { machine, project, auto: String(d.reason === 'auto') }, { n: 1 }, r.time_created, r.id));
    }
  }
  return out;
}

/** A state change of a session (from the hub's readings): how long it was in the state it left. */
export function stateLine(machine, project, from, to, seconds, t) {
  return line('opencode_state', { machine, project, from, to }, { seconds: num(seconds) }, t);
}

/** A new OpenCode version seen on a machine. */
export function versionLine(machine, version, t) {
  return typeof version === 'string' && version ? `opencode_version,machine=${tag(machine)} version="${version.replace(/["\\]/g, '')}" ${BigInt(Math.round(t)) * 1_000_000n}` : null;
}

/**
 * @param {{ url: string, org: string, bucket?: string, token: string, send?: typeof fetch }} o
 * @returns {{ write(lines: string[]): Promise<void> }}  never throws; a failure is logged at most once a minute
 */
export function createInfluxExport({ url, org, bucket = 'opencode', token, send = fetch }) {
  const endpoint = `${String(url).replace(/\/+$/, '')}/api/v2/write?org=${encodeURIComponent(org)}&bucket=${encodeURIComponent(bucket)}&precision=ns`;
  let lastWarn = 0;
  const warn = msg => { if (Date.now() - lastWarn > 60_000) { lastWarn = Date.now(); console.warn(`central: InfluxDB: ${msg}`); } };
  return {
    async write(lines) {
      const body = (lines ?? []).filter(Boolean).join('\n');
      if (!body) return;
      try {
        const res = await send(endpoint, { method: 'POST', headers: { Authorization: `Token ${token}`, 'Content-Type': 'text/plain; charset=utf-8' }, body, signal: AbortSignal.timeout(10_000) });
        if (!res.ok) warn(`HTTP ${res.status}`);
      } catch (err) {
        warn(err?.message ?? String(err));
      }
    },
  };
}
