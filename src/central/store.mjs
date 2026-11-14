// OpenCode Central, hub side: one database per machine at <dir>/<machine>/opencode.db, laid out as OpenCode's own
// (the tables and columns src/db.mjs reads), so openDb() and createMonitor() run on it unchanged. Rows are upserted
// by id, an older copy never overwriting a newer one; a batch whose seq was already applied is acknowledged and
// skipped. Kept 180 days.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const MACHINE = /^[a-z0-9-]{1,32}$/;
export const KEEP_DAYS = 180;

const LAYOUT = {
  session: ['id', 'parent_id', 'directory', 'title', 'time_created', 'time_updated', 'version', 'model', 'time_compacting'],
  message: ['id', 'session_id', 'time_created', 'time_updated', 'data'],
  part: ['id', 'message_id', 'session_id', 'time_created', 'time_updated', 'data'],
  session_v2: ['id', 'parent_id', 'directory', 'title', 'time_created', 'time_updated', 'version', 'model', 'fork_session_id'],
  session_message: ['id', 'session_id', 'type', 'seq', 'time_created', 'time_updated', 'data'],
};
const TODO = ['id', 'session_id', 'content', 'status', 'priority', 'position'];

const SCHEMA = `
  pragma journal_mode = wal;
  create table if not exists session (${LAYOUT.session.map(c => (c === 'id' ? 'id text primary key' : c)).join(', ')});
  create table if not exists message (${LAYOUT.message.map(c => (c === 'id' ? 'id text primary key' : c)).join(', ')});
  create table if not exists part (${LAYOUT.part.map(c => (c === 'id' ? 'id text primary key' : c)).join(', ')});
  create table if not exists session_v2 (${LAYOUT.session_v2.map(c => (c === 'id' ? 'id text primary key' : c)).join(', ')});
  create table if not exists session_message (${LAYOUT.session_message.map(c => (c === 'id' ? 'id text primary key' : c)).join(', ')});
  create table if not exists todo (${TODO.join(', ')});
  create table if not exists central_meta (k text primary key, v text);
  create index if not exists message_session on message(session_id, time_created);
  create index if not exists part_session on part(session_id, time_updated);
  create index if not exists part_created on part(time_created);
  create index if not exists session_updated on session(time_updated);
  create index if not exists sm_session on session_message(session_id, time_created);
  create index if not exists sm_created on session_message(time_created);
`;

const ts = 'coalesce(time_updated, time_created)';

export function createCentralStore({ dir }) {
  mkdirSync(dir, { recursive: true });
  const open = new Map(); // machine -> { db, stmts }

  function check(name) {
    if (!MACHINE.test(String(name ?? ''))) throw new Error(`machine name refused: ${JSON.stringify(name)}`);
  }

  function conn(name) {
    check(name);
    let c = open.get(name);
    if (c) return c;
    mkdirSync(join(dir, name), { recursive: true });
    const db = new DatabaseSync(join(dir, name, 'opencode.db'));
    db.exec(SCHEMA);
    const upsert = {};
    for (const [table, cols] of Object.entries(LAYOUT)) {
      const set = cols.filter(col => col !== 'id').map(col => `${col} = excluded.${col}`).join(', ');
      upsert[table] = db.prepare(`insert into ${table} (${cols.join(', ')}) values (${cols.map(() => '?').join(', ')})
        on conflict(id) do update set ${set}
        where coalesce(excluded.time_updated, excluded.time_created, 0) >= coalesce(${table}.time_updated, ${table}.time_created, 0)`);
    }
    c = {
      db,
      upsert,
      todoClear: db.prepare('delete from todo'),
      todoInsert: db.prepare(`insert into todo (${TODO.join(', ')}) values (${TODO.map(() => '?').join(', ')})`),
      getMeta: db.prepare('select v from central_meta where k = ?'),
      setMeta: db.prepare('insert into central_meta (k, v) values (?, ?) on conflict(k) do update set v = excluded.v'),
    };
    open.set(name, c);
    return c;
  }

  const meta = (c, k) => c.getMeta.get(k)?.v ?? null;
  // every machine with a database on disk, opened or not
  const names = () => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isDirectory() && MACHINE.test(e.name) && existsSync(join(dir, e.name, 'opencode.db'))).map(e => e.name).sort() : []);
  const value = v => (v === undefined ? null : v);

  return {
    /** Applies one opened batch. @returns {{ seq: number, applied: boolean }} */
    apply(batch) {
      const c = conn(batch?.machine);
      const seq = Number(batch.seq);
      if (!Number.isInteger(seq) || seq < 1) throw new Error('seq refused');
      // A new agent instance (its queue lost or rebuilt) counts from 1 again: forget the old high-water mark.
      const instance = typeof batch.instance === 'string' && /^[0-9a-f]{16}$/.test(batch.instance) ? batch.instance : null;
      const fresh = instance !== null && instance !== meta(c, 'instance');
      const last = fresh ? 0 : Number(meta(c, 'last_seq') ?? 0);
      if (seq <= last) return { seq, applied: false };
      c.db.exec('begin');
      try {
        for (const [table, rows] of Object.entries(batch.rows ?? {})) {
          if (!Array.isArray(rows)) continue;
          if (table === 'todo') {
            c.todoClear.run();
            for (const r of rows) c.todoInsert.run(...TODO.map(col => value(r?.[col])));
          } else if (c.upsert[table]) {
            for (const r of rows) if (r && typeof r.id === 'string') c.upsert[table].run(...LAYOUT[table].map(col => value(r[col])));
          }
        }
        if (batch.facts) c.setMeta.run('facts', JSON.stringify(batch.facts));
        c.setMeta.run('last_seq', String(seq));
        if (instance) c.setMeta.run('instance', instance);
        c.setMeta.run('last_at', String(Date.now()));
        c.db.exec('commit');
      } catch (err) {
        c.db.exec('rollback');
        throw err;
      }
      return { seq, applied: true };
    },
    /** Every machine that has sent something. */
    machines() {
      return names().map(name => {
        const c = conn(name);
        const facts = meta(c, 'facts');
        return { name, lastSeq: Number(meta(c, 'last_seq') ?? 0), lastAt: Number(meta(c, 'last_at') ?? 0) || null, facts: facts ? JSON.parse(facts) : null };
      });
    },
    /** The folder openDb() reads for this machine. */
    dataDirOf(name) { check(name); return join(dir, name); },
    facts(name) { const f = meta(conn(name), 'facts'); return f ? JSON.parse(f) : null; },
    /** Each OpenCode version that wrote a top-level session, oldest first: when its first and last one began, how many. */
    versions(name) {
      return conn(name).db.prepare(`select version, min(time_created) as firstAt, max(time_created) as lastAt, count(*) as sessions
        from (select version, time_created from session where parent_id is null union all select version, time_created from session_v2 where parent_id is null)
        where version is not null and version != '' group by version order by firstAt`).all().map(r => ({ version: r.version, firstAt: Number(r.firstAt), lastAt: Number(r.lastAt), sessions: Number(r.sessions) }));
    },
    getMeta: (name, k) => meta(conn(name), k),
    setMeta: (name, k, v) => conn(name).setMeta.run(k, String(v)),
    /** Rows past KEEP_DAYS, and what they leave orphaned. */
    prune(now = Date.now()) {
      const cutoff = now - KEEP_DAYS * 86_400_000;
      for (const name of names()) {
        const { db } = conn(name);
        db.exec('begin');
        try {
          for (const t of ['part', 'message', 'session_message', 'session', 'session_v2']) db.prepare(`delete from ${t} where ${ts} < ?`).run(cutoff);
          db.exec(`delete from message where session_id not in (select id from session);
            delete from part where message_id not in (select id from message);
            delete from session_message where session_id not in (select id from session_v2);
            delete from todo where session_id not in (select id from session union select id from session_v2);`);
          db.exec('commit');
        } catch (err) {
          db.exec('rollback');
          throw err;
        }
      }
    },
    row: (name, table, id) => (LAYOUT[table] ? conn(name).db.prepare(`select * from ${table} where id = ?`).get(id) : undefined),
    all: (name, table) => (LAYOUT[table] || table === 'todo' ? conn(name).db.prepare(`select * from ${table} order by rowid`).all() : []),
    close() { for (const { db } of open.values()) db.close(); open.clear(); },
  };
}
