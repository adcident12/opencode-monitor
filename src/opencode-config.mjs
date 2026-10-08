// Reads the few facts the monitor needs from OpenCode's own config: model context limits,
// MCP server names, and model server addresses. Those files also hold API keys and MCP
// credentials; nothing else is kept, and nothing read here is ever written anywhere.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

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

/**
 * @returns {{
 *   limits: Map<string, number>,                         "provider/model" -> context window
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
    for (const [serverName, server] of Object.entries(config.mcp ?? {})) {
      if (server && typeof server === 'object') {
        mcp.set(serverName, { name: serverName, type: server.type === 'remote' ? 'remote' : 'local', enabled: server.enabled !== false });
      }
    }
  }
  return { limits, mcp: [...mcp.values()], providers: [...providers.values()] };
}
