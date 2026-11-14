// OpenCode Central, agent side: what changed in opencode.db since the last read, scrubbed (src/central/scrub.mjs).
// Opened read-only; a database OpenCode holds locked is a cycle skipped (null), never an error and never a wait.
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { scrubRow } from './scrub.mjs';

export const TABLES = ['session', 'message', 'part', 'todo', 'session_v2', 'session_message'];
const BUSY = /locked|busy/i;

/**
 * @param {{ dbPath: string, hmacKey: Buffer, machine: string, overlapMs?: number, maxBytes?: number }} o
 * @returns {{ next(cursor: object): { rows: Record<string, object[]>, cursor: object, more: boolean } | null }}
 *   cursor: per table { t, id, caught } (keyset position; caught = read to the end last time), todo: { h }.
 */
// 3 MB of rows: sealed and base64-encoded (x1.34) it stays under the hub's 5 MB per request.
// since: the first read of a table starts there (ms); older history is never sent. null: everything.
export function createExtractor({ dbPath, hmacKey, machine, overlapMs = 120_000, maxBytes = 3 * 2 ** 20, since = null }) {
  const ctx = { hmacKey, machine };
  let db = null;
  let layout = null; // table -> time column, or null for a table without one (todo)
  // What was already returned inside the overlap: "table:id" -> its time. The overlap re-reads the last
  // minutes on every cycle; a row seen with the same time is not returned again (a restart sends it once more).
  const seen = new Map();

  function open() {
    if (db) return;
    // Set only when the whole layout was read: a lock half way leaves nothing behind for the next cycle.
    const conn = new DatabaseSync(dbPath, { readOnly: true });
    try {
      conn.exec('pragma busy_timeout = 100');
      const found = {};
      for (const t of TABLES) {
        const cols = new Set(conn.prepare(`pragma table_info(${t})`).all().map(c => c.name));
        if (!cols.size) continue;
        // Read by position only with an id to order by; a table without one (OpenCode's todo) is read whole.
        const time = cols.has('time_updated') ? 'time_updated' : cols.has('time_created') ? 'time_created' : null;
        found[t] = cols.has('id') ? time : null;
      }
      db = conn;
      layout = found;
    } catch (err) {
      conn.close();
      throw err;
    }
  }

  function readTable(table, col, cur, budget, marks) {
    const first = Number.isFinite(since) ? { t: since, id: '' } : null;
    const start = !cur ? first : cur.caught && overlapMs > 0 ? { t: cur.t - overlapMs, id: '' } : { t: cur.t, id: cur.id };
    const sql = start
      ? `select * from ${table} where ${col} > ? or (${col} = ? and id > ?) order by ${col}, id`
      : `select * from ${table} order by ${col}, id`;
    const stmt = db.prepare(sql);
    const rows = [];
    let last = null;
    let more = false;
    for (const r of start ? stmt.iterate(start.t, start.t, start.id) : stmt.iterate()) {
      const key = `${table}:${r.id}`;
      if (seen.get(key) === r[col]) { last = r; continue; }
      const s = scrubRow(table, r, ctx);
      const size = Buffer.byteLength(JSON.stringify(s)); // bytes: the filler is 2 bytes in UTF-8
      if (rows.length && budget.left - size < 0) { more = true; break; } // r waits for the next batch
      budget.left -= size;
      rows.push(s);
      marks.push([key, r[col]]); // remembered only once the caller has queued the batch (acknowledge)
      last = r;
    }
    const cursor = last ? { t: last[col], id: last.id, caught: !more } : (cur ? { ...cur, caught: true } : null);
    return { rows, cursor, more };
  }

  function readWhole(table, cur) {
    const rows = db.prepare(`select * from ${table}`).all().map(r => scrubRow(table, r, ctx));
    const h = createHash('sha256').update(JSON.stringify(rows)).digest('hex');
    // changed: sent even when now empty, so the hub drops a list the machine no longer has
    return cur?.h === h ? { rows: [], cursor: cur } : { rows, cursor: { h }, changed: true };
  }

  return {
    next(cursor = {}) {
      try {
        open();
        const out = { rows: {}, cursor: { ...cursor }, more: false };
        const budget = { left: maxBytes };
        const marks = [];
        for (const table of TABLES) {
          if (!Object.hasOwn(layout, table)) continue;
          const col = layout[table];
          const r = col ? readTable(table, col, cursor[table], budget, marks) : readWhole(table, cursor[table]);
          if (r.rows.length || r.changed) out.rows[table] = r.rows;
          if (r.cursor) out.cursor[table] = r.cursor;
          if (r.more) { out.more = true; break; }
        }
        Object.defineProperty(out, 'marks', { value: marks, enumerable: false });
        return out;
      } catch (err) {
        if (BUSY.test(String(err?.message))) return null;
        throw err;
      }
    },
    /** The batch from next() is queued: its rows count as sent from now on (and what left the overlap is forgotten). */
    acknowledge(r) {
      for (const [k, t] of r?.marks ?? []) seen.set(k, t);
      const times = Object.values(r?.cursor ?? {}).filter(c => typeof c?.t === 'number').map(c => c.t);
      if (times.length) { const oldest = Math.min(...times) - overlapMs; for (const [k, t] of seen) if (t < oldest) seen.delete(k); }
    },
    close() { db?.close(); db = null; },
  };
}
