// Read-only access to OpenCode's SQLite database. Nothing here writes.
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { UserError } from './config.mjs';
import { normalizeV2 } from './db-v2.mjs';

// Columns the monitor cannot work without. Checked at startup so a schema change in a
// future OpenCode release fails loudly instead of showing wrong states.
const REQUIRED = {
  session: ['id', 'parent_id', 'directory', 'title', 'time_created', 'time_updated'],
  message: ['id', 'session_id', 'time_created', 'data'],
  part: ['id', 'message_id', 'session_id', 'time_created', 'time_updated', 'data'],
};
const OPTIONAL_SESSION = ['version', 'model', 'time_compacting'];
// OpenCode 2's tables. Checked only when they exist: a 1.x database has none of them.
const V2_TABLES = {
  session_v2: ['id', 'parent_id', 'directory', 'title', 'time_created', 'time_updated'],
  session_message: ['id', 'session_id', 'type', 'seq', 'time_created', 'time_updated', 'data'],
};
// How long rows read from OpenCode 2's tables are reused by the next query for the same range.
const V2_REUSE_MS = 5000;
// How many sessions' rows are kept ready for the live view; the page shows 30 by default.
const V2_LIVE_SESSIONS = 64;

// How much of a running command's output is read; only its last lines are shown.
export const OUTPUT_TAIL_CHARS = 1500;
// How much of each tool result is checked for secret-looking values (then discarded).
const OUTPUT_SCAN_CHARS = 8000;

const PART_COLUMNS = `
  id, message_id, time_created, time_updated,
  json_extract(data,'$.type') type,
  json_extract(data,'$.tool') tool,
  json_extract(data,'$.state.status') status,
  json_extract(data,'$.state.time.start') started,
  json_extract(data,'$.state.time.end') ended,
  substr(json_extract(data,'$.state.input.command'),1,4000) cmd,
  substr(json_extract(data,'$.state.input.filePath'),1,1000) file,
  substr(json_extract(data,'$.state.input.questions[0].question'),1,1000) question,
  substr(json_extract(data,'$.state.input.description'),1,1000) descr,
  substr(json_extract(data,'$.state.input.url'),1,500) url,
  substr(json_extract(data,'$.state.input.name'),1,100) skill,
  json_extract(data,'$.files') files,
  substr(coalesce(json_extract(data,'$.state.metadata.output'), json_extract(data,'$.state.output')),1,${OUTPUT_SCAN_CHARS}) scan_out,
  substr(json_extract(data,'$.state.input'),1,1000) input,
  length(json_extract(data,'$.state.input')) input_len,
  substr(json_extract(data,'$.state.error'),1,500) error,
  length(json_extract(data,'$.state.metadata.output')) out_len,
  case when json_extract(data,'$.state.status') = 'running'
    then substr(json_extract(data,'$.state.metadata.output'), -${OUTPUT_TAIL_CHARS}) end out_tail,
  json_extract(data,'$.reason') reason,
  json_extract(data,'$.tokens.input') tokens_input,
  json_extract(data,'$.tokens.cache.read') tokens_cache_read,
  json_extract(data,'$.tokens.cache.write') tokens_cache_write,
  json_extract(data,'$.tokens.output') tokens_output,
  json_extract(data,'$.tokens.total') tokens_total,
  json_extract(data,'$.auto') auto,
  json_extract(data,'$.overflow') overflow,
  (select json_extract(m.data,'$.summary') from message m where m.id = part.message_id) msg_summary`;

/** The database file, opened so that nothing can be written to it. */
function openReadOnly(path) {
  if (!existsSync(path)) {
    throw new UserError(
      `OpenCode database not found at ${path}.\n` +
      'Run OpenCode at least once, point --data-dir at its data directory, or try --sample.'
    );
  }
  try {
    return new DatabaseSync(path, { readOnly: true });
  } catch (err) {
    throw new UserError(`Could not open ${path} read-only: ${err.message}`);
  }
}

/**
 * The columns of each table the monitor reads. Refuses, saying what is missing, a database
 * that does not have the layout the queries were written for.
 * @returns {Record<string, Set<string>>}
 */
function checkLayout(db, path) {
  const columns = {};
  const problems = [];
  for (const [table, required] of Object.entries({ ...REQUIRED, ...V2_TABLES })) {
    columns[table] = new Set(db.prepare(`pragma table_info(${table})`).all().map(c => c.name));
    if (columns[table].size) problems.push(...required.filter(c => !columns[table].has(c)).map(c => `column "${table}.${c}" is missing`));
    else if (Object.hasOwn(REQUIRED, table)) problems.push(`table "${table}" is missing`);
  }
  if (problems.length) {
    db.close();
    throw new UserError(
      `The OpenCode database at ${path} does not have the layout this monitor was written for:\n` +
      problems.map(p => `  - ${p}`).join('\n') +
      '\nYour OpenCode version is probably newer or older than the tested ones (see README).'
    );
  }
  return columns;
}

/** Sessions from both versions' tables, one row a session: the one updated last (1.x on a tie). */
function mergeSessions(v1, v2) {
  const byId = new Map(v1.map(s => [s.id, s]));
  for (const s of v2) {
    const old = byId.get(s.id);
    if (!old || s.time_updated > old.time_updated) byId.set(s.id, s);
  }
  return [...byId.values()];
}

/**
 * OpenCode 2's sessions, as 1.x rows. null for a database without its tables.
 * OpenCode 2 copied every 1.x session into its own tables when it was installed, so a message
 * is read from there only when it is newer than everything the 1.x tables hold for its
 * session: a session begun in OpenCode 2, or a 1.x session carried on in it.
 */
function openV2(db, columns) {
  if (!Object.keys(V2_TABLES).every(table => columns[table].size)) return null;
  // A fork copies its parent's history into itself, each row as it was: those rows are the
  // parent's work, counted there. Only what the fork did itself is read for it.
  const FORKED = columns.session_v2.has('fork_session_id')
    ? ' and not exists (select 1 from session_v2 f where f.id = sm.session_id and f.fork_session_id is not null and sm.time_created < f.time_created)'
    : '';
  const NEWER = `not exists (select 1 from message m where m.session_id = sm.session_id and m.time_created >= sm.time_created)${FORKED}`;
  const ROWS = `select sm.id, sm.session_id, sm.type, sm.seq, sm.time_created, sm.time_updated, sm.data from session_message sm
    where sm.type in ('user','assistant','synthetic','compaction','idle') and ${NEWER}`;
  const ORDER = 'order by sm.session_id, sm.time_created, sm.seq';
  const optional = OPTIONAL_SESSION.map(c => (columns.session_v2.has(c) ? c : `null as ${c}`)).join(', ');
  const SESSION = `id, parent_id, directory, title, time_created, time_updated, ${optional}`;
  const stmt = {
    since: db.prepare(`${ROWS} and sm.time_created >= ? ${ORDER}`),
    inSessions: db.prepare(`${ROWS} and sm.session_id in (select value from json_each(?)) ${ORDER}`),
    ofSession: db.prepare(`${ROWS} and sm.session_id = ? ${ORDER}`),
    // Enough of a session's end to tell how its last reply ended.
    lastOfSession: db.prepare(`select * from (${ROWS} and sm.session_id = ? order by sm.time_created desc, sm.seq desc limit 40)
      order by time_created, seq`),
    signature: db.prepare(`select count(*) n, max(sm.time_updated) t from session_message sm where sm.session_id = ? and ${NEWER}`),
    sessions: db.prepare(`select ${SESSION} from session_v2 where time_updated >= ?`),
    recent: db.prepare(`select ${SESSION} from session_v2 where time_updated >= ? order by time_updated desc limit ?`),
    tree: db.prepare(`with recursive tree(id) as (select ? union all select s.id from session_v2 s join tree on s.parent_id = tree.id)
      select id, parent_id, directory, title, time_created, time_updated, ${columns.session_v2.has('version') ? 'version' : 'null as version'} from session_v2 where id in (select id from tree)`),
  };

  // The Stats page asks for a range's tools, messages, spans... one after another: the rows
  // are read and turned into 1.x rows once for all of them.
  let reused = { key: null, at: 0, value: null };
  const rowsOf = (key, read) => {
    const now = Date.now();
    if (reused.key !== key || now - reused.at > V2_REUSE_MS) reused = { key, at: now, value: normalizeV2(read()) };
    return reused.value;
  };
  // The live view's rows of a session, read again only when the session has changed. Kept for
  // the sessions looked at lately and no more: a long session's rows are many.
  const live = new Map(); // session id -> { key, parts }, the one used last at the end
  const partsOf = sessionId => {
    const { n, t } = stmt.signature.get(sessionId);
    const key = `${n}|${t}`;
    let entry = live.get(sessionId);
    if (!entry || entry.key !== key) entry = { key, parts: n ? normalizeV2(stmt.ofSession.all(sessionId)).parts : [] };
    live.delete(sessionId);
    live.set(sessionId, entry);
    while (live.size > V2_LIVE_SESSIONS) live.delete(live.keys().next().value);
    return entry.parts;
  };

  return {
    since: since => rowsOf(`since|${since}`, () => stmt.since.all(since)),
    inSessions: ids => rowsOf(`in|${JSON.stringify(ids)}`, () => stmt.inSessions.all(JSON.stringify(ids))),
    sessions: since => stmt.sessions.all(since),
    recent: (since, limit) => stmt.recent.all(since, limit),
    tree: sessionId => stmt.tree.all(sessionId),
    /** Copies: the monitor marks and trims the rows it is given. */
    parts: (sessionId, updatedSince) => partsOf(sessionId).filter(p => p.time_updated >= updatedSince).map(p => ({ ...p })),
    partStats: sessionId => {
      const parts = partsOf(sessionId);
      return { count: parts.length, max_updated: parts.length ? Math.max(...parts.map(p => p.time_updated)) : null };
    },
    lastMessages: sessionId => normalizeV2(stmt.lastOfSession.all(sessionId)).messages,
  };
}

/** Models used, from both versions' rows, as the 1.x query counts them. */
function mergeModels(v1, messages) {
  const byKey = new Map(v1.map(m => [`${m.provider}|${m.model}`, { ...m }]));
  for (const m of messages) {
    if (m.role !== 'assistant' || !m.model_id) continue;
    const key = `${m.provider_id}|${m.model_id}`;
    const entry = byKey.get(key) ?? { provider: m.provider_id, model: m.model_id, requests: 0, last: 0 };
    entry.requests++;
    entry.last = Math.max(entry.last ?? 0, m.time_created);
    byKey.set(key, entry);
  }
  return [...byKey.values()];
}

/**
 * A database made by OpenCode 2 alone has none of the 1.x tables (only one upgraded from 1.x
 * keeps them). The queries below are written for both, so each missing 1.x table gets an empty
 * stand-in: a temporary table, held in memory by this connection. The file is not touched: it
 * stays opened read-only, and a 1.x database, or one with a table half there, gets none.
 */
function standInFor1x(db) {
  const has = table => db.prepare(`pragma table_info(${table})`).all().length > 0;
  if (!Object.keys(V2_TABLES).every(has)) return;
  const missing = Object.keys(REQUIRED).filter(table => !has(table));
  if (!missing.length) return;
  db.exec('pragma temp_store = memory');
  for (const table of missing) db.exec(`create temp table ${table} (${REQUIRED[table].map(column => `${column}${column.startsWith('time_') ? ' integer' : ' text'}`).join(', ')})`);
}

export function openDb(dataDir) {
  const path = join(dataDir, 'opencode.db');
  const db = openReadOnly(path);
  standInFor1x(db);
  const columns = checkLayout(db, path);

  const optional = OPTIONAL_SESSION.map(c => (columns.session.has(c) ? c : `null as ${c}`)).join(', ');
  const stmt = {
    sessions: db.prepare(`select id, parent_id, directory, title, time_created, time_updated, ${optional}
      from session where time_updated >= ? order by time_updated desc limit ?`),
    partStats: db.prepare('select count(*) count, max(time_updated) max_updated from part where session_id = ?'),
    parts: db.prepare(`select ${PART_COLUMNS} from part where session_id = ? and time_updated >= ?`),
    messages: db.prepare(`select id, time_created,
        json_extract(data,'$.role') role,
        json_extract(data,'$.error.name') error,
        json_extract(data,'$.finish') finish,
        json_extract(data,'$.time.completed') completed,
        json_extract(data,'$.modelID') model_id,
        json_extract(data,'$.providerID') provider_id
      from message where session_id = ? order by time_created desc, id desc limit 12`),
  };
  // The agent's own task list. Older OpenCode versions may not have the table.
  const hasTodos = ['session_id', 'content', 'status', 'position']
    .every(c => db.prepare('pragma table_info(todo)').all().some(col => col.name === c));
  const todos = hasTodos ? db.prepare('select content, status from todo where session_id = ? order by position') : null;
  // For the stats page: only which session and which status, never the text of an item.
  const todoStatus = hasTodos ? db.prepare('select session_id, status from todo') : null;

  // For the stats page: everything in a time range, with only the fields it counts.
  const statsStmt = {
    sessions: db.prepare(`select id, parent_id, directory, title, time_created, time_updated, ${columns.session.has('version') ? 'version' : 'null as version'} from session where time_updated >= ?`),
    tools: db.prepare(`select id, session_id, time_created, time_updated,
        json_extract(data,'$.tool') tool,
        json_extract(data,'$.state.status') status,
        json_extract(data,'$.state.time.start') started,
        json_extract(data,'$.state.time.end') ended,
        substr(json_extract(data,'$.state.input.command'),1,500) cmd,
        substr(json_extract(data,'$.state.input.filePath'),1,500) file,
        substr(json_extract(data,'$.state.input.questions[0].question'),1,300) question,
        substr(json_extract(data,'$.state.input.description'),1,300) descr,
        substr(json_extract(data,'$.state.input.name'),1,100) skill,
        substr(json_extract(data,'$.state.error'),1,200) error
      from part where time_created >= ? and json_extract(data,'$.type') = 'tool'`),
    messages: db.prepare(`select id, session_id, time_created, json_extract(data,'$.role') role, json_extract(data,'$.time.completed') completed,
        json_extract(data,'$.summary') summary,
        json_extract(data,'$.finish') finish,
        json_extract(data,'$.error.name') error_name,
        json_extract(data,'$.agent') agent,
        json_extract(data,'$.providerID') provider_id,
        json_extract(data,'$.modelID') model_id,
        json_extract(data,'$.tokens.input') tokens_input,
        json_extract(data,'$.tokens.output') tokens_output,
        json_extract(data,'$.tokens.reasoning') tokens_reasoning,
        json_extract(data,'$.tokens.cache.read') tokens_cache_read,
        json_extract(data,'$.tokens.cache.write') tokens_cache_write,
        json_extract(data,'$.cost') cost
      from message where time_created >= ?`),
    compactions: db.prepare(`select session_id, time_created, json_extract(data,'$.auto') auto, json_extract(data,'$.overflow') overflow
      from part where time_created >= ? and json_extract(data,'$.type') = 'compaction'`),
    // Per model request: when the first token arrived, and when the model stopped writing
    // (the end of its last text, or the moment its last tool call was complete and could run).
    // Thinking and writing, timed: the stretches of a reply that are not tool calls.
    spans: db.prepare(`select session_id, json_extract(data,'$.type') type, json_extract(data,'$.time.start') s, json_extract(data,'$.time.end') e
      from part where time_created >= ? and json_extract(data,'$.type') in ('reasoning','text')`),
    // The files each edit changed.
    patches: db.prepare(`select session_id, time_created, json_extract(data,'$.files') files
      from part where time_created >= ? and json_extract(data,'$.type') = 'patch'`),
    // Every task list the agent wrote. OpenCode's todo table keeps only the latest list of a
    // session, so plans that were replaced are only found here.
    todoWrites: db.prepare(`select session_id, time_created, json_extract(data,'$.state.input.todos') todos
      from part where time_created >= ? and json_extract(data,'$.tool') = 'todowrite' and json_extract(data,'$.state.status') = 'completed'`),
    // Sessions whose plans are in todowrite calls at all, whenever they were written.
    todoWriters: db.prepare(`select distinct session_id from part where json_extract(data,'$.tool') = 'todowrite'`),
    // Which models were used, for the setup page: only ids and counts.
    models: db.prepare(`select json_extract(data,'$.providerID') provider, json_extract(data,'$.modelID') model, count(*) requests, max(time_created) last
      from message where time_created >= ? and json_extract(data,'$.role') = 'assistant' and json_extract(data,'$.modelID') is not null group by 1, 2`),
    steps: db.prepare(`select message_id,
        min(case when json_extract(data,'$.type') = 'step-start' then time_created end) first_token,
        max(case json_extract(data,'$.type')
          when 'tool' then json_extract(data,'$.state.time.start')
          when 'text' then json_extract(data,'$.time.end')
          when 'reasoning' then json_extract(data,'$.time.end') end) written
      from part where time_created >= ? and json_extract(data,'$.type') in ('step-start','tool','text','reasoning')
      group by message_id`),
  };
  // For a replay: one session and every session under it, with the same fields as for Stats.
  const IN_TREE = "session_id in (select value from json_each(?))";
  const narrowed = name => db.prepare(statsStmt[name].sourceSQL.replace('time_created >= ?', IN_TREE));
  const replayStmt = {
    tree: db.prepare(`with recursive tree(id) as (select ? union all select s.id from session s join tree on s.parent_id = tree.id)
      select id, parent_id, directory, title, time_created, time_updated, ${columns.session.has('version') ? 'version' : 'null as version'} from session where id in (select id from tree)`),
    ...Object.fromEntries(['tools', 'messages', 'compactions', 'spans', 'steps', 'todoWrites'].map(name => [name, narrowed(name)])),
  };

  // Update times of each tool call, from OpenCode's event log. Indexed by session, so only
  // the sessions that had prompts are read. Absent in versions without the event table.
  const hasEvents = ['aggregate_id', 'type', 'data'].every(c => db.prepare('pragma table_info(event)').all().some(col => col.name === c));
  const toolEvents = hasEvents
    ? db.prepare(`select json_extract(data,'$.part.id') part_id, json_extract(data,'$.time') t from event
        where aggregate_id = ? and type = 'message.part.updated.1' and json_extract(data,'$.part.type') = 'tool'`)
    : null;

  const v2 = openV2(db, columns);
  // The rows of one kind from both versions' tables. A message OpenCode 2 adds on its own
  // (a "continue" after a compaction) is not a prompt of yours, so the figures leave it out.
  const ROWS = ['tools', 'messages', 'compactions', 'spans', 'steps', 'patches', 'todoWrites'];
  const withV2 = (name, rows, fromV2) => {
    if (!v2) return rows;
    const more = fromV2()[name];
    return [...rows, ...(name === 'messages' ? more.filter(m => !m.synthetic) : more)];
  };

  return {
    path,
    /** Whether OpenCode 2's tables are read too. */
    v2: Boolean(v2),
    stats: {
      sessions: since => (v2 ? mergeSessions(statsStmt.sessions.all(since), v2.sessions(since)) : statsStmt.sessions.all(since)),
      ...Object.fromEntries(ROWS.map(name => [name, since => withV2(name, statsStmt[name].all(since), () => v2.since(since))])),
      models: since => (v2 ? mergeModels(statsStmt.models.all(since), v2.since(since).messages) : statsStmt.models.all(since)),
      todoStatus: () => (todoStatus ? todoStatus.all() : []),
      todoWriters: () => new Set(statsStmt.todoWriters.all().map(r => r.session_id)),
      toolEvents: sessionId => (toolEvents ? toolEvents.all(sessionId) : []),
    },
    replay: {
      /** The session and every session under it. */
      tree: sessionId => (v2 ? mergeSessions(replayStmt.tree.all(sessionId), v2.tree(sessionId)) : replayStmt.tree.all(sessionId)),
      ...Object.fromEntries(ROWS.filter(name => name !== 'patches').map(name => [name, ids => withV2(name, replayStmt[name].all(JSON.stringify(ids)), () => v2.inSessions(ids))])),
    },
    todos: sessionId => (todos ? todos.all(sessionId) : []),
    recentSessions: (since, limit) => {
      const rows = stmt.sessions.all(since, limit);
      if (!v2) return rows;
      return mergeSessions(rows, v2.recent(since, limit)).sort((a, b) => b.time_updated - a.time_updated).slice(0, limit);
    },
    partStats: sessionId => {
      const own = stmt.partStats.get(sessionId);
      if (!v2) return own;
      const more = v2.partStats(sessionId);
      return { count: own.count + more.count, max_updated: Math.max(own.max_updated ?? 0, more.max_updated ?? 0) || null };
    },
    parts: (sessionId, updatedSince = 0) => [...stmt.parts.all(sessionId, updatedSince), ...(v2 ? v2.parts(sessionId, updatedSince) : [])],
    // Oldest first.
    lastMessages: sessionId => {
      const rows = stmt.messages.all(sessionId).reverse();
      if (!v2) return rows;
      return [...rows, ...v2.lastMessages(sessionId)].sort((a, b) => a.time_created - b.time_created).slice(-12);
    },
    close: () => db.close(),
  };
}
