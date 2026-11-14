// OpenCode Central: the content contract. Every row an agent sends leaves through scrubRow, and scrubRow keeps
// only what is listed here (a whitelist): times, numbers, statuses, tool / model / agent names, the session title
// and version. Text a person or a model wrote, tool output and errors become filler of the same length (so the
// figures that count lengths still work), tool inputs and paths become keyed hashes (so the same call made twice
// is still seen as the same), and anything not listed — a key a future OpenCode adds included — is dropped.
import { createHmac } from 'node:crypto';

export const FILLER = '·';
export const MAX_FILL = 65536;

const fill = v => (typeof v === 'string' ? FILLER.repeat(Math.min(v.length, MAX_FILL)) : undefined);
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const bool = v => (typeof v === 'boolean' ? v : undefined);
const name = (max = 200) => v => (typeof v === 'string' ? v.slice(0, max) : undefined);
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Only the numbers of an object, at any depth (tokens, time). */
function numbers(v) {
  if (!isObj(v)) return undefined;
  const out = {};
  for (const [k, x] of Object.entries(v)) {
    const kept = typeof x === 'number' ? num(x) : numbers(x);
    if (kept !== undefined) out[k] = kept;
  }
  return out;
}

/** The keys of `src` that `spec` lists, each through its function; undefined results are left out. */
function pick(src, spec) {
  if (!isObj(src)) return undefined;
  const out = {};
  for (const [k, f] of Object.entries(spec)) {
    if (!Object.hasOwn(src, k)) continue;
    const v = f(src[k]);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

const hash16 = (ctx, s) => createHmac('sha256', ctx.hmacKey).update(String(s)).digest('hex').slice(0, 16);
const pathHash = ctx => v => (typeof v === 'string' ? `f:${hash16(ctx, v)}` : undefined);
const paths = ctx => v => (Array.isArray(v) ? v.map(pathHash(ctx)).filter(Boolean) : undefined);

/**
 * A tool's input: a keyed hash of the whole input, padded so the JSON keeps its length, plus the few values that
 * are not content (where a read started and how many lines, whether a command ran in the background, the status
 * of each todo).
 */
function input(ctx) {
  return v => {
    if (v === undefined || v === null) return undefined;
    const json = JSON.stringify(v) ?? '';
    const out = {};
    if (isObj(v)) {
      for (const k of ['offset', 'limit']) if (num(v[k]) !== undefined) out[k] = v[k];
      if (bool(v.background) !== undefined) out.background = v.background;
      if (Array.isArray(v.todos)) out.todos = v.todos.map(t => ({ status: name(20)(t?.status) ?? null }));
    }
    const h = `#${hash16(ctx, json)}`;
    out['#'] = h;
    const short = json.length - JSON.stringify(out).length;
    if (short > 0) out['#'] = h + FILLER.repeat(short);
    return out;
  };
}

/** An error: its name and type stay, its message becomes filler. */
const error = v => {
  if (typeof v === 'string') return fill(v);
  return pick(v, { name: name(200), type: name(80), message: fill });
};

function state(ctx) {
  const toolCalls = v => (Array.isArray(v) ? v.map(c => pick(c, { tool: name(200), status: name(40), input: input(ctx) })).filter(Boolean) : undefined);
  return v => pick(v, {
    status: name(40),
    time: numbers,
    input: input(ctx),
    output: fill,
    error,
    metadata: m => pick(m, { output: fill, toolCalls }),
    content: c => (Array.isArray(c) ? c.map(i => pick(i, { type: name(40), text: fill })).filter(Boolean) : undefined),
  });
}

const model = v => pick(v, { providerID: name(200), id: name(200) });
const summaryMark = v => (v === undefined || v === null || v === false ? undefined : true);

function partData(ctx) {
  return v => pick(v, {
    type: name(40), tool: name(200), reason: name(40), auto: bool, overflow: bool, cost: num,
    tokens: numbers, time: numbers, text: fill, files: paths(ctx), state: state(ctx),
  });
}

const messageData = v => pick(v, {
  role: name(20), modelID: name(200), providerID: name(200), model, cost: num, tokens: numbers, time: numbers,
  finish: name(40), agent: name(80), mode: name(80), error: e => pick(e, { name: name(200) }), summary: summaryMark,
});

function v2Data(ctx, type) {
  const item = i => pick(i, { type: name(40), id: name(100), name: name(100), time: numbers, text: fill, state: state(ctx) });
  const common = { time: numbers };
  const byType = {
    assistant: {
      ...common, finish: name(40), agent: name(80), cost: num, model, tokens: numbers, error: e => pick(e, { name: name(200), type: name(80) }),
      snapshot: s => pick(s, { files: paths(ctx) }),
      content: c => (Array.isArray(c) ? c.map(item).filter(Boolean) : undefined),
    },
    compaction: {
      ...common, reason: name(40), overflow: bool, status: name(40), cost: num, model, tokens: numbers,
      error: e => pick(e, { name: name(200), type: name(80) }),
    },
    idle: { ...common, outcome: name(40) },
  };
  return v => pick(v, byType[type] ?? common);
}

/** '/<machine>/<last folder of the path>', whatever the separators. */
function pseudoDir(dir, machine) {
  const last = String(dir ?? '').split(/[\\/]+/).filter(Boolean).pop() ?? '';
  return `/${machine}/${last}`;
}

const SESSION_COLUMNS = ['id', 'parent_id', 'time_created', 'time_updated', 'version', 'model', 'time_compacting', 'fork_session_id'];

function columns(row, names) {
  const out = {};
  for (const n of names) if (Object.hasOwn(row, n)) out[n] = row[n];
  return out;
}

function withData(row, names, scrub) {
  const out = columns(row, names);
  let parsed = null;
  try { parsed = JSON.parse(row.data); } catch { parsed = null; }
  out.data = JSON.stringify((isObj(parsed) && scrub(parsed)) || {});
  return out;
}

/**
 * One row of OpenCode's database as it may leave the machine.
 * @param {'session'|'message'|'part'|'todo'|'session_v2'|'session_message'} table
 * @param {object} row
 * @param {{ hmacKey: Buffer, machine: string }} ctx
 */
export function scrubRow(table, row, ctx) {
  switch (table) {
    case 'session':
    case 'session_v2':
      return { ...columns(row, SESSION_COLUMNS), directory: pseudoDir(row.directory, ctx.machine), title: name(200)(row.title) ?? null };
    case 'message':
      return withData(row, ['id', 'session_id', 'time_created', 'time_updated'], messageData);
    case 'part':
      return withData(row, ['id', 'message_id', 'session_id', 'time_created', 'time_updated'], partData(ctx));
    case 'session_message':
      return withData(row, ['id', 'session_id', 'type', 'seq', 'time_created', 'time_updated'], v2Data(ctx, row.type));
    case 'todo':
      return { ...columns(row, ['id', 'session_id', 'status', 'priority', 'position', 'time_created', 'time_updated']), content: fill(row.content) ?? '' };
    default:
      throw new Error(`scrubRow: unknown table ${table}`);
  }
}

