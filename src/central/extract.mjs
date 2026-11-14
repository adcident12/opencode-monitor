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
export function createExtractor({ dbPath, hmacKey, machine, overlapMs = 120_000, maxBytes = 2 * 2 ** 20 }) {
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
        found[t] = cols.has('time_updated') ? 'time_updated' : cols.has('time_created') ? 'time_created' : null;
      }
      db = conn;
      layout = found;
    } catch (err) {
      conn.close();
      throw err;
    }
  }

  function readTable(table, col, cur, budget) {
    const start = !cur ? null : cur.caught && overlapMs > 0 ? { t: cur.t - overlapMs, id: '' } : { t: cur.t, id: cur.id };
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
      const size = JSON.stringify(s).length;
      if (rows.length && budget.left - size < 0) { more = true; break; } // r waits for the next batch
      budget.left -= size;
      rows.push(s);
      seen.set(key, r[col]);
      last = r;
    }
    const cursor = last ? { t: last[col], id: last.id, caught: !more } : (cur ? { ...cur, caught: true } : null);
    return { rows, cursor, more };
  }

  function readWhole(table, cur) {
    const rows = db.prepare(`select * from ${table}`).all().map(r => scrubRow(table, r, ctx));
    const h = createHash('sha256').update(JSON.stringify(rows)).digest('hex');
    return cur?.h === h ? { rows: [], cursor: cur } : { rows, cursor: { h } };
  }

  return {
    next(cursor = {}) {
      try {
        open();
        const out = { rows: {}, cursor: { ...cursor }, more: false };
        const budget = { left: maxBytes };
        for (const table of TABLES) {
          if (!Object.hasOwn(layout, table)) continue;
          const col = layout[table];
          const r = col ? readTable(table, col, cursor[table], budget) : readWhole(table, cursor[table]);
          if (r.rows.length) out.rows[table] = r.rows;
          if (r.cursor) out.cursor[table] = r.cursor;
          if (r.more) { out.more = true; break; }
        }
        // forget what has fallen out of every table's overlap
        const oldest = Math.min(...Object.values(out.cursor).filter(c => typeof c?.t === 'number').map(c => c.t)) - overlapMs;
        for (const [k, t] of seen) if (t < oldest) seen.delete(k);
        return out;
      } catch (err) {
        if (BUSY.test(String(err?.message))) return null;
        throw err;
      }
    },
    close() { db?.close(); db = null; },
  };
}
