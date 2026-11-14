// OpenCode Central, hub side: POST /ingest. Write-only: the machine shows its token, the body is a sealed batch
// for that machine, and the answer is {ok:true, seq} or {ok:false} — never anything from the store, never why.
import { openSealed } from './seal.mjs';
import { matchToken } from './tokens.mjs';
import { contentFree } from './guard.mjs';

const HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };

function answer(res, status, body, close = false) {
  res.writeHead(status, close ? { ...HEADERS, connection: 'close' } : HEADERS);
  res.end(JSON.stringify(body));
}

function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > max) { reject(Object.assign(new Error('too big'), { tooBig: true })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{ store, tokens: () => Record<string,string>, privateKey: string, maxBytes?: number, onApplied?: (batch: object, machine: string) => void }} o
 */
export async function handleIngest(req, res, { store, tokens, privateKey, maxBytes = 5 * 2 ** 20, onApplied = () => {} }) {
  if (req.method !== 'POST') return answer(res, 405, { ok: false });
  const auth = String(req.headers.authorization ?? '');
  const machine = matchToken(tokens(), auth.startsWith('Bearer ') ? auth.slice(7).trim() : '');
  if (!machine) { req.resume(); return answer(res, 401, { ok: false }); }
  if (Number(req.headers['content-length'] ?? 0) > maxBytes) return answer(res, 413, { ok: false }, true);
  let text;
  try {
    text = await readBody(req, maxBytes);
  } catch (err) {
    return answer(res, err?.tooBig ? 413 : 400, { ok: false }, true);
  }
  let batch;
  try {
    batch = openSealed(JSON.parse(text), privateKey);
  } catch {
    return answer(res, 400, { ok: false });
  }
  if (!batch || batch.machine !== machine) return answer(res, 400, { ok: false });
  // Text that got past the agent's scrub (an old or broken agent) is refused whole, never stored.
  if (!contentFree(batch)) return answer(res, 400, { ok: false });
  let result;
  try {
    result = store.apply(batch);
  } catch {
    return answer(res, 400, { ok: false });
  }
  if (result.applied) {
    try { onApplied(batch, machine); } catch { /* a follower's failure never fails the machine's send */ }
  }
  return answer(res, 200, { ok: true, seq: result.seq });
}
