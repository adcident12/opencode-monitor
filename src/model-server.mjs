// What a llama.cpp server really runs, from its /props: the model it has loaded and the
// context it was started with. OpenCode knows only what its own config says, and a server
// started with another model or a smaller context answers all the same, under the name it
// was asked for. Pure, but for reading a key the user named.
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { trimEndOf } from './text.mjs';

/** Where a server's settings are: its root, not the OpenAI path OpenCode talks to. */
export const propsUrl = baseURL => `${trimEndOf(trimEndOf(baseURL, '/').replace(/\/v1$/, ''), '/')}/props`;

/**
 * The key to ask with, from where the config says it is: "{env:NAME}" or "{file:path}". A
 * key written into config.json itself is refused, so it cannot be shared with the file.
 * @returns {{key: string|null, problem: string|null}}
 */
export function resolveKey(spec, env = process.env, read = readFileSync) {
  if (spec == null || spec === '') return { key: null, problem: null };
  const m = /^\{(env|file):(.+)\}$/.exec(String(spec));
  if (!m) return { key: null, problem: 'not_a_reference' };
  if (m[1] === 'env') {
    const value = env[m[2]];
    return value ? { key: value.trim(), problem: null } : { key: null, problem: 'env_missing' };
  }
  try {
    const value = read(m[2], 'utf8').trim();
    return value ? { key: value, problem: null } : { key: null, problem: 'file_empty' };
  } catch {
    return { key: null, problem: 'file_unreadable' };
  }
}

/**
 * The few settings that matter, from a llama-server /props answer; null when it is not one.
 * `model` is the name it answers to (--alias), only when it has one: a file name says which
 * file, not which name OpenCode should use.
 */
export function parseProps(json) {
  if (!json || typeof json !== 'object') return null;
  const settings = json.default_generation_settings ?? {};
  const nCtx = Number(settings.n_ctx ?? json.n_ctx);
  const file = typeof json.model_path === 'string' && json.model_path ? basename(json.model_path.replaceAll('\\', '/')) : null;
  const alias = typeof json.model_alias === 'string' && json.model_alias && json.model_alias !== json.model_path ? json.model_alias : null;
  if (!file && !alias && !Number.isFinite(nCtx)) return null;
  return {
    model: alias,
    file,
    nCtx: Number.isFinite(nCtx) && nCtx > 0 ? nCtx : null,
    slots: Number.isInteger(json.total_slots) ? json.total_slots : null,
    build: typeof json.build_info === 'string' ? json.build_info.slice(0, 60) : null,
  };
}

/**
 * Where OpenCode and the server disagree, for the models OpenCode is asking this server for:
 *   model    a session asks for one model and the server has another loaded (it answers anyway)
 *   context  OpenCode takes the window to be larger than the server's: a request past the
 *            server's is refused before OpenCode compacts
 * @param {object} server   parseProps of this server
 * @param {string[]} asked  the models OpenCode asks this provider for now
 * @param {(model: string) => number|null} contextOf  OpenCode's window for a model of it
 */
export function mismatchesOf(server, asked, contextOf) {
  if (!server) return [];
  const out = [];
  for (const model of new Set(asked)) {
    if (server.model && model.toLowerCase() !== server.model.toLowerCase()) out.push({ kind: 'model', asked: model, loaded: server.model });
    const context = contextOf(model);
    if (server.nCtx && context && context > server.nCtx) out.push({ kind: 'context', model, opencode: context, server: server.nCtx });
  }
  return out;
}

/** Where a server says what each of its slots is doing. */
export const slotsUrl = baseURL => propsUrl(baseURL).replace(/\/props$/, '/slots');

/**
 * Each slot of a llama.cpp server, from its /slots: whether it is working on a request, and
 * how far: the prompt read (from its cache, then processed) and the tokens written. No text.
 * @returns {object[]|null}  null when it is not such an answer
 */
export function parseSlots(json) {
  if (!Array.isArray(json)) return null;
  const n = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return json.filter(s => s && typeof s === 'object').map(s => ({
    id: n(s.id),
    busy: s.is_processing === true,
    task: s.id_task ?? null,
    prompt: n(s.n_prompt_tokens),
    cached: n(s.n_prompt_tokens_cache),
    processed: n(s.n_prompt_tokens_processed),
    written: n(s.next_token?.[0]?.n_decoded ?? s.n_decoded),
  }));
}

/**
 * What a busy slot is doing, from now and the reading before:
 *   reading  the prompt: tokens processed so far (and reused from its cache), and how fast
 *   writing  the answer: tokens so far, and how fast
 * llama.cpp does not say how long the prompt is until it has read it all (its count grows a
 * batch at a time), so no share and no time left is given for reading: they would be guesses.
 * A rate needs two readings of the same request; without them it is null.
 */
export function slotProgress(slot, before = null, ms = 0) {
  if (!slot?.busy) return null;
  const same = before?.busy && before.task === slot.task && ms > 0;
  const per = (now, then) => (same && now > then ? ((now - then) / ms) * 1000 : null);
  if (slot.written > 0) {
    const rate = per(slot.written, before?.written);
    return { phase: 'writing', written: slot.written, rate: rate && Math.round(rate * 10) / 10 };
  }
  const rate = per(slot.processed, before?.processed);
  return { phase: 'reading', read: slot.processed, cached: slot.cached, rate: rate && Math.round(rate) };
}
