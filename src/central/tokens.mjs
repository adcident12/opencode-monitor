// OpenCode Central, hub side: the hub's key pair and the machines' tokens. A token is shown once when made; only
// its SHA-256 is kept (tokens.json, readable by the owner only). Making a new one for a machine revokes the old.
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { generateHubKeys } from './seal.mjs';
import { MACHINE } from './store.mjs';

const sha = s => createHash('sha256').update(String(s)).digest();

function writePrivate(path, text) {
  writeFileSync(`${path}.tmp`, text, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
  try { chmodSync(path, 0o600); } catch { /* Windows: ACLs of the folder apply */ }
}

/** The hub's keys, made on the first call and kept in <dir>/hub-key.json. */
export function initHubKeys(dir) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'hub-key.json');
  if (existsSync(path)) return { ...JSON.parse(readFileSync(path, 'utf8')), created: false };
  const keys = generateHubKeys();
  writePrivate(path, JSON.stringify(keys));
  return { ...keys, created: true };
}

/** machine -> SHA-256 hex of its token. */
export function readTokens(dir) {
  try { return JSON.parse(readFileSync(join(dir, 'tokens.json'), 'utf8')); } catch { return {}; }
}

/** A new token for a machine, replacing (revoking) any it had. Returned once; only its hash is stored. */
export function issueToken(dir, machine) {
  if (!MACHINE.test(String(machine ?? ''))) throw new Error('machine must be 1-32 of a-z, 0-9 and -');
  mkdirSync(dir, { recursive: true });
  const token = randomBytes(32).toString('base64url');
  writePrivate(join(dir, 'tokens.json'), JSON.stringify({ ...readTokens(dir), [machine]: sha(token).toString('hex') }, null, 2));
  return token;
}

/** The machine a presented token belongs to, or null. Compares every entry in constant time. */
export function matchToken(tokens, presented) {
  if (typeof presented !== 'string' || !presented) return null;
  const got = sha(presented);
  let found = null;
  for (const [machine, hex] of Object.entries(tokens ?? {})) {
    const want = Buffer.from(String(hex), 'hex');
    if (want.length === got.length && timingSafeEqual(want, got) && !found) found = machine;
  }
  return found;
}
