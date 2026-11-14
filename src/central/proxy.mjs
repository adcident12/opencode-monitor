// OpenCode Central, hub side: behind a reverse proxy that logs people in itself (for example the homelab's admin
// login), the proxy adds a secret header to every request it lets through, and the hub admits those without asking
// its own access key. The proxy must set (overwrite) that header itself, never pass a client's. The hub still
// answers only under its own names (central.hosts) and only to GET and /mcp, exactly as through the normal gate.
import { timingSafeEqual } from 'node:crypto';

const MIN_SECRET = 32;

function secretMatches(req, proxy) {
  if (!proxy || typeof proxy.secret !== 'string' || proxy.secret.length < MIN_SECRET) return false;
  const got = req.headers?.[String(proxy.header || 'x-ocm-proxy').toLowerCase()];
  if (typeof got !== 'string') return false;
  const a = Buffer.from(got);
  const b = Buffer.from(proxy.secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{ hosts: Set<string> }} access  from createAccess (the names the hub answers to)
 * @param {{ header?: string, secret: string } | null} proxy  central.proxy
 * @param {(req, res, access) => ({ toMcp: boolean, url: URL } | null)} normalAdmit  main.mjs admit()
 * @returns {{ toMcp: boolean, url: URL } | null}  null: the answer was already sent
 */
export function admitVia(req, res, access, proxy, normalAdmit) {
  if (!secretMatches(req, proxy)) return normalAdmit(req, res, access);
  const toMcp = req.url === '/mcp' || String(req.url).startsWith('/mcp?');
  if (!access.hosts.has(String(req.headers.host).toLowerCase()) || (req.method !== 'GET' && !toMcp)) {
    res.writeHead(403).end();
    return null;
  }
  return { toMcp, url: new URL(req.url, 'http://127.0.0.1') };
}
