// OpenCode Central, hub side: a second check, after the agent's scrub. A batch whose strings are not all filler,
// keyed hashes or short single-line names (an old or broken agent that let text through) is refused whole, so
// text a person or a model wrote never lands in the hub's database.
const FILLER = /^·*$/;
const HASH = /^#[0-9a-f]{16}·*$/;
const PATH = /^f:[0-9a-f]{16}$/;
const NAME_MAX = 200;

const okString = s => FILLER.test(s) || HASH.test(s) || PATH.test(s) || (s.length <= NAME_MAX && !/[\r\n]/.test(s));

function clean(v) {
  if (typeof v === 'string') return okString(v);
  if (Array.isArray(v)) return v.every(clean);
  if (v && typeof v === 'object') return Object.entries(v).every(([k, x]) => okString(k) && clean(x));
  return true;
}

function cleanRow(table, row) {
  for (const [k, v] of Object.entries(row ?? {})) {
    if (k === 'data') {
      let d;
      try { d = JSON.parse(String(v)); } catch { return false; }
      if (!clean(d)) return false;
    } else if (table === 'todo' && k === 'content') {
      if (typeof v !== 'string' || !FILLER.test(v)) return false;
    } else if (!clean(v)) {
      return false;
    }
  }
  return true;
}

/** True when every row and the facts of an opened batch hold nothing but figures, statuses and names. */
export function contentFree(batch) {
  for (const [table, rows] of Object.entries(batch?.rows ?? {})) {
    if (!Array.isArray(rows) || !rows.every(r => cleanRow(table, r))) return false;
  }
  return clean(batch?.facts ?? null);
}
