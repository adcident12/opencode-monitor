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

// JSON with // and /* */ comments and trailing commas -> plain JSON.
export function stripJsonc(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
    } else if (ch === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] !== '}' && text[j] !== ']') out += ch;
      i++;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

function collectLimits(limits, providers) {
  for (const [providerId, provider] of Object.entries(providers ?? {})) {
    for (const [modelId, model] of Object.entries(provider?.models ?? {})) {
      const context = model?.limit?.context;
      if (Number.isFinite(context) && context > 0) limits.set(`${providerId}/${modelId}`, context);
    }
  }
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
  const cache = new Map(); // directory -> { at, entries }

  function read(dir) {
    const hit = cache.get(dir);
    if (hit && now() - hit.at < everyMs) return hit.entries;
    const entries = [];
    if (isSafeLocalPath(dir)) {
      for (const file of PROJECT_CONFIG_FILES) entries.push(...mcpEntries(readProjectJson(join(dir, file))));
    }
    cache.set(dir, { at: now(), entries });
    return entries;
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

  return { forDirs };
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
  const mcp = new Map();
  const providers = new Map();

  // Catalogue OpenCode caches for built-in providers; user config below overrides it.
  const cacheDir = env.XDG_CACHE_HOME ? join(env.XDG_CACHE_HOME, 'opencode') : join(homedir(), '.cache', 'opencode');
  collectLimits(limits, readJson(join(cacheDir, 'models.json')));

  for (const name of ['opencode.json', 'opencode.jsonc']) {
    const config = readJson(join(configDir, name));
    if (!config) continue;
    collectLimits(limits, config.provider);
    for (const [id, provider] of Object.entries(config.provider ?? {})) {
      const baseURL = provider?.options?.baseURL;
      if (typeof baseURL === 'string' && /^https?:\/\//i.test(baseURL)) providers.set(id, { id, baseURL });
    }
    for (const entry of mcpEntries(config)) mcp.set(entry.name, { ...entry, type: entry.type ?? 'local' });
  }
  return { limits, mcp: [...mcp.values()], providers: [...providers.values()] };
}
