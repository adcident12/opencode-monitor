// Which model each model server had loaded, and when: OpenCode records the name it asked for,
// and a server started with another model answers all the same, so a reply's own record can
// name a model that never wrote it. Read off each server's settings (llama.cpp's /props) while
// the monitor runs, and kept beside the history.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

const HOUR = 3_600_000;
// A line says what was loaded from its time until the next line, or this long at most: one is
// written each hour while nothing changes, so a gap longer than that is time not seen (the
// monitor was not running) and nothing is said for it.
const VALID_MS = HOUR + 10 * 60_000;
const DAY = 86_400_000;

/**
 * @param {object} options
 * @param {string|null} options.file      data/served.jsonl; null keeps it in memory
 * @param {number} options.retentionDays
 * @param {boolean} [options.readOnly]    for a process that only reads it (the MCP server)
 */
export function createServedLog({ file, retentionDays, readOnly = false, now = Date.now() }) {
  const byProvider = new Map(); // provider -> [{ t, model, file, nCtx }], oldest first
  const cutoff = now - retentionDays * DAY;
  if (file && existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      try {
        const e = JSON.parse(line);
        if (typeof e?.provider === 'string' && typeof e.t === 'number' && e.t >= cutoff) add(e);
      } catch {
        // A broken line says nothing.
      }
    }
    for (const list of byProvider.values()) list.sort((a, b) => a.t - b.t);
  }

  function add(e) {
    if (!byProvider.has(e.provider)) byProvider.set(e.provider, []);
    byProvider.get(e.provider).push({ t: e.t, model: e.model ?? null, file: e.file ?? null, nCtx: e.nCtx ?? null });
  }

  return {
    /** What a server has loaded now: kept when it changed, or an hour after the last line. */
    record(provider, settings, at = Date.now()) {
      if (readOnly || !settings) return;
      const last = byProvider.get(provider)?.at(-1);
      const same = last && last.model === (settings.model ?? null) && last.file === (settings.file ?? null) && last.nCtx === (settings.nCtx ?? null);
      if (same && at - last.t < HOUR) return;
      const entry = { t: at, provider, model: settings.model ?? null, file: settings.file ?? null, nCtx: settings.nCtx ?? null };
      add(entry);
      if (!file) return;
      try {
        mkdirSync(dirname(file), { recursive: true });
        appendFileSync(file, `${JSON.stringify(entry)}\n`);
      } catch (err) {
        console.warn(`Could not write ${file}: ${err.code ?? err.message}`);
      }
    },
    /** What the server had loaded at `t`, or null when that time was not seen. */
    servedAt(provider, t) {
      const list = byProvider.get(provider);
      if (!list?.length) return null;
      let i = list.length - 1;
      while (i >= 0 && list[i].t > t) i--;
      if (i < 0) return null;
      const until = Math.min(list[i + 1]?.t ?? Infinity, list[i].t + VALID_MS);
      return t < until ? list[i] : null;
    },
  };
}

/**
 * Replies whose record names another model than the one the server had loaded when it wrote
 * them, by the two names; and how many replies could be checked at all.
 * @param {(provider: string, t: number) => object|null} servedAt
 */
export function servedAsOf(messages, servedAt, { from, to, inScope = () => true }) {
  const differ = new Map();
  let checked = 0;
  for (const m of messages) {
    if (m.role !== 'assistant' || !m.model_id || !m.provider_id || m.agent === 'compaction') continue;
    if (m.time_created < from || m.time_created > to || !inScope(m.session_id)) continue;
    const served = servedAt(m.provider_id, m.time_created);
    // Only a server that says the name it answers to (--alias) can be compared.
    if (!served?.model) continue;
    checked++;
    if (served.model.toLowerCase() === m.model_id.toLowerCase()) continue;
    const key = `${m.provider_id}/${m.model_id}|${m.provider_id}/${served.model}`;
    differ.set(key, (differ.get(key) ?? 0) + 1);
  }
  return {
    checked,
    differ: [...differ].map(([key, replies]) => {
      const [asked, served] = key.split('|');
      return { asked, served, replies };
    }).sort((a, b) => b.replies - a.replies),
  };
}
