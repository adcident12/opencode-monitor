// Reads the few facts the monitor needs from OpenCode's own config: model context limits,
// MCP server names, and model server addresses. Those files also hold API keys and MCP
// credentials; nothing else is kept, and nothing read here is ever written anywhere.
import { lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isSafeLocalPath } from './git.mjs';

const PROJECT_CONFIG_FILES = ['opencode.json', 'opencode.jsonc', join('.opencode', 'opencode.json'), join('.opencode', 'opencode.jsonc')];
const PROJECT_CONFIG_MAX_BYTES = 256 * 1024;
const MAX_NAME = 64;

/** Where the comment starting at `i` ends, or `i` itself when no comment starts there. */
function commentEnd(text, i) {
  if (text.startsWith('//', i)) {
    const end = text.indexOf('\n', i);
    return end === -1 ? text.length : end;
  }
  if (text.startsWith('/*', i)) {
    const end = text.indexOf('*/', i + 2);
    return end === -1 ? text.length : end + 2;
  }
  return i;
}

/** Past any space and comments from `j`. */
function skipBlank(text, j) {
  for (;;) {
    while (j < text.length && /\s/.test(text[j])) j++;
    const end = commentEnd(text, j);
    if (end === j) return j;
    j = end;
  }
}

/** Just past the closing quote of the string that opens at `i`. */
function stringEnd(text, i) {
  let j = i + 1;
  while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
  return j + 1;
}

/** A comma with only space and comments between it and the closing bracket. */
function isTrailingComma(text, i) {
  const next = text[skipBlank(text, i + 1)];
  return next === '}' || next === ']';
}

// JSON with // and /* */ comments and trailing commas -> plain JSON.
export function stripJsonc(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const end = ch === '"' ? stringEnd(text, i) : commentEnd(text, i);
    if (ch === '"') out += text.slice(i, end);
    else if (end === i && !(ch === ',' && isTrailingComma(text, i))) out += ch;
    i = Math.max(end, i + 1);
  }
  return out;
}

/** A token limit as the config gives it, or null when it is missing or not a positive number. */
const limitOf = value => (Number.isFinite(value) && value > 0 ? value : null);

function collectLimits(limits, providers, reserves = new Map()) {
  for (const [providerId, provider] of Object.entries(providers ?? {})) {
    for (const [modelId, model] of Object.entries(provider?.models ?? {})) {
      const key = `${providerId}/${modelId}`;
      const context = limitOf(model?.limit?.context);
      if (context != null) limits.set(key, context);
      // What compaction needs: the output it keeps free, and an explicit input limit if any.
      const output = limitOf(model?.limit?.output);
      const input = limitOf(model?.limit?.input);
      if (output != null || input != null) reserves.set(key, { output, input });
    }
  }
}

// OpenCode's own constants (1.18): the most it ever keeps free for a reply, unless
// OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX says otherwise, and the default reserve for models
// that have an input limit.
export const OUTPUT_TOKEN_MAX = 32_000;
export const COMPACTION_RESERVED = 20_000;

/** OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX, if set to a positive number. */
export function outputTokenMaxFrom(env = process.env) {
  const n = Number(env.OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * The size at which OpenCode compacts a session, worked out the way OpenCode itself does
 * (SessionCompaction.isOverflow), from the limits the user set for that model:
 *
 *   reply  = min(limit.output, outputTokenMax) || outputTokenMax
 *   limit.input set:  limit.input - (compaction.reserved ?? min(20 000, reply))
 *   otherwise:        limit.context - reply
 *
 * It compacts when a request's total tokens reach this. null when it never compacts on its
 * own: compaction.auto is false, or the context window is unknown or 0.
 *
 * @param {number|null} context  limit.context of the model
 * @param {{output: number|null, input: number|null}} [reserve]  limit.output and limit.input
 * @param {{auto?: boolean, reserved?: number|null, outputTokenMax?: number|null}} [settings]
 */
export function compactionPoint(context, reserve, { auto = true, reserved = null, outputTokenMax = null } = {}) {
  if (auto === false || !context) return null;
  const max = outputTokenMax > 0 ? outputTokenMax : OUTPUT_TOKEN_MAX;
  const reply = Math.min(reserve?.output ?? Number.NaN, max) || max;
  if (reserve?.input) return Math.max(0, reserve.input - (reserved ?? Math.min(COMPACTION_RESERVED, reply)));
  return Math.max(0, context - reply);
}

/** The `compaction` settings of one config file: only what decides when it happens. */
function compactionOf(config) {
  const c = config?.compaction;
  if (!c || typeof c !== 'object') return {};
  const out = {};
  if (typeof c.auto === 'boolean') out.auto = c.auto;
  if (Number.isFinite(c.reserved) && c.reserved >= 0) out.reserved = c.reserved;
  return out;
}

/**
 * Every file OpenCode may read its settings from: the global ones, and each project's.
 * Paths only; nothing is opened here.
 */
export function configFiles(configDir, projectDirs = []) {
  const files = ['opencode.json', 'opencode.jsonc'].map(name => join(configDir, name));
  for (const dir of projectDirs) if (dir && isSafeLocalPath(dir)) files.push(...PROJECT_CONFIG_FILES.map(name => join(dir, name)));
  return files;
}

function readJson(path) {
  try {
    return JSON.parse(stripJsonc(readFileSync(path, 'utf8')));
  } catch {
    return null;
  }
}

function mcpEntries(config) {
  const entries = [];
  for (const [name, server] of Object.entries(config?.mcp ?? {})) {
    if (!server || typeof server !== 'object' || !name || name.length > MAX_NAME) continue;
    // A project entry that only flips "enabled" has no type of its own.
    const type = ['local', 'remote'].includes(server.type) ? server.type : null;
    entries.push({ name, type, enabled: server.enabled !== false });
  }
  return entries;
}

// A small regular file on a local disk, or nothing. Project directories are not trusted.
function readProjectJson(path) {
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.size > PROJECT_CONFIG_MAX_BYTES) return null;
  } catch {
    return null;
  }
  return readJson(path);
}

/**
 * MCP servers that project-level configs define or switch on. A server enabled only inside
 * one project is invisible in the global config, and its tools would belong to nobody.
 * Only names, types and the enabled flag are kept; commands and credentials are not.
 */
export function createProjectMcp({ everyMs = 60_000, now = () => Date.now() } = {}) {
  const cache = new Map(); // directory -> { at, entries, limits, reserves, compaction }

  function load(dir) {
    const hit = cache.get(dir);
    if (hit && now() - hit.at < everyMs) return hit;
    const found = { at: now(), entries: [], limits: new Map(), reserves: new Map(), compaction: {} };
    if (isSafeLocalPath(dir)) {
      for (const file of PROJECT_CONFIG_FILES) {
        const config = readProjectJson(join(dir, file));
        if (!config) continue;
        found.entries.push(...mcpEntries(config));
        collectLimits(found.limits, config.provider, found.reserves);
        found.compaction = { ...found.compaction, ...compactionOf(config) };
      }
    }
    cache.set(dir, found);
    return found;
  }
  const read = dir => load(dir).entries;

  /**
   * What a project's own config says about model limits and compaction; empty when it says
   * nothing. Applied over the global config, as OpenCode does.
   * @returns {{limits: Map<string, number>, reserves: Map<string, object>, compaction: object}}
   */
  function settingsFor(dir) {
    if (!dir) return { limits: new Map(), reserves: new Map(), compaction: {} };
    const { limits, reserves, compaction } = load(dir);
    return { limits, reserves, compaction };
  }

  /** @returns {{name: string, type: string|null, enabled: boolean}[]} one entry per name */
  function forDirs(dirs) {
    const wanted = new Set(dirs.filter(Boolean));
    const byName = new Map();
    for (const dir of wanted) {
      for (const entry of read(dir)) {
        const known = byName.get(entry.name);
        if (known) {
          known.enabled ||= entry.enabled;
          known.type ??= entry.type;
        } else {
          byName.set(entry.name, { ...entry });
        }
      }
    }
    if (cache.size > 200) for (const dir of cache.keys()) if (!wanted.has(dir)) cache.delete(dir);
    return [...byName.values()];
  }

  return { forDirs, settingsFor };
}

/**
 * @returns {{
 *   limits: Map<string, number>,                        "provider/model" -> context window
 *   mcp: {name: string, type: string, enabled: boolean}[],
 *   providers: {id: string, baseURL: string}[]           only providers with their own address
 * }}
 */
export function loadOpencodeConfig(configDir, env = process.env) {
  const limits = new Map();
  const reserves = new Map(); // "provider/model" -> { output, input }
  let compaction = {}; // { auto, reserved } as the user set them
  const mcp = new Map();
  const providers = new Map();

  // Catalogue OpenCode caches for built-in providers; user config below overrides it.
  const cacheDir = env.XDG_CACHE_HOME ? join(env.XDG_CACHE_HOME, 'opencode') : join(homedir(), '.cache', 'opencode');
  collectLimits(limits, readJson(join(cacheDir, 'models.json')), reserves);

  for (const name of ['opencode.json', 'opencode.jsonc']) {
    const config = readJson(join(configDir, name));
    if (!config) continue;
    collectLimits(limits, config.provider, reserves);
    compaction = { ...compaction, ...compactionOf(config) };
    for (const [id, provider] of Object.entries(config.provider ?? {})) {
      const baseURL = provider?.options?.baseURL;
      if (typeof baseURL === 'string' && /^https?:\/\//i.test(baseURL)) providers.set(id, { id, baseURL });
    }
    for (const entry of mcpEntries(config)) mcp.set(entry.name, { ...entry, type: entry.type ?? 'local' });
  }
  return { limits, reserves, compaction, mcp: [...mcp.values()], providers: [...providers.values()] };
}
