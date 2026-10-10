// Read-only access to OpenCode's SQLite database. Nothing here writes.
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { UserError } from './config.mjs';

// Columns the monitor cannot work without. Checked at startup so a schema change in a
// future OpenCode release fails loudly instead of showing wrong states.
const REQUIRED = {
  session: ['id', 'parent_id', 'directory', 'title', 'time_created', 'time_updated'],
  message: ['id', 'session_id', 'time_created', 'data'],
  part: ['id', 'message_id', 'session_id', 'time_created', 'time_updated', 'data'],
};
const OPTIONAL_SESSION = ['version', 'model', 'time_compacting'];

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
  json_extract(data,'$.tokens.cache.write') tokens_cache_write`;

export function openDb(dataDir) {
  const path = join(dataDir, 'opencode.db');
  if (!existsSync(path)) {
    throw new UserError(
      `OpenCode database not found at ${path}.\n` +
      'Run OpenCode at least once, point --data-dir at its data directory, or try --sample.'
    );
  }
  let db;
  try {
    db = new DatabaseSync(path, { readOnly: true });
  } catch (err) {
    throw new UserError(`Could not open ${path} read-only: ${err.message}`);
  }

  const columns = {};
  const problems = [];
  for (const [table, required] of Object.entries(REQUIRED)) {
    columns[table] = new Set(db.prepare(`pragma table_info(${table})`).all().map(c => c.name));
    if (!columns[table].size) problems.push(`table "${table}" is missing`);
    else for (const c of required) if (!columns[table].has(c)) problems.push(`column "${table}.${c}" is missing`);
  }
  if (problems.length) {
    db.close();
    throw new UserError(
      `The OpenCode database at ${path} does not have the layout this monitor was written for:\n` +
      problems.map(p => `  - ${p}`).join('\n') +
      '\nYour OpenCode version is probably newer or older than the tested ones (see README).'
    );
  }

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

  // For the stats page: everything in a time range, with only the fields it counts.
  const statsStmt = {
    sessions: db.prepare('select id, parent_id, directory, title, time_created, time_updated from session where time_updated >= ?'),
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
    messages: db.prepare(`select session_id, time_created, json_extract(data,'$.role') role, json_extract(data,'$.time.completed') completed
      from message where time_created >= ?`),
    compactions: db.prepare("select session_id, time_created from part where time_created >= ? and json_extract(data,'$.type') = 'compaction'"),
  };
  // Update times of each tool call, from OpenCode's event log. Indexed by session, so only
  // the sessions that had prompts are read. Absent in versions without the event table.
  const hasEvents = ['aggregate_id', 'type', 'data'].every(c => db.prepare('pragma table_info(event)').all().some(col => col.name === c));
  const toolEvents = hasEvents
    ? db.prepare(`select json_extract(data,'$.part.id') part_id, json_extract(data,'$.time') t from event
        where aggregate_id = ? and type = 'message.part.updated.1' and json_extract(data,'$.part.type') = 'tool'`)
    : null;

  return {
    path,
    stats: {
      sessions: since => statsStmt.sessions.all(since),
      tools: since => statsStmt.tools.all(since),
      messages: since => statsStmt.messages.all(since),
      compactions: since => statsStmt.compactions.all(since),
      toolEvents: sessionId => (toolEvents ? toolEvents.all(sessionId) : []),
    },
    todos: sessionId => (todos ? todos.all(sessionId) : []),
    recentSessions: (since, limit) => stmt.sessions.all(since, limit),
    partStats: sessionId => stmt.partStats.get(sessionId),
    parts: (sessionId, updatedSince = 0) => stmt.parts.all(sessionId, updatedSince),
    // Oldest first.
    lastMessages: sessionId => stmt.messages.all(sessionId).reverse(),
    close: () => db.close(),
  };
}
