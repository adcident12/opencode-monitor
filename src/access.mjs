// Who may see the page when the monitor is open to the local network (--lan). This machine
// always may; every other device must show the access key once, and is then remembered by
// a cookie. Without --lan none of this is used: the monitor listens on 127.0.0.1 only.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname, networkInterfaces } from 'node:os';
import { dirname } from 'node:path';

const COOKIE = 'ocm_key';
const YEAR = 365 * 24 * 60 * 60;

/** Did the request come from this machine itself? */
export const isLoopback = address => /^(?:(?:::ffff:)?127.0.0.1|::1)$/.test(String(address));

/** This machine's addresses on its networks: IPv4, not the loopback one. */
export function lanAddresses(interfaces = networkInterfaces()) {
  return Object.values(interfaces).flat().filter(a => a?.family === 'IPv4' && !a.internal).map(a => a.address);
}

/** The key kept in `file`, made on first use: 32 characters no one could guess. */
export function loadAccessKey(file) {
  if (existsSync(file)) {
    const kept = readFileSync(file, 'utf8').trim();
    if (/^[\w-]{24,}$/.test(kept)) return kept;
  }
  const key = randomBytes(24).toString('base64url');
  mkdirSync(dirname(file), { recursive: true });
  // Readable by its owner only, where the system has such a thing.
  writeFileSync(file, `${key}\n`, { mode: 0o600 });
  return key;
}

// Compared by their hashes, in constant time: how long it takes says nothing about the key.
const digest = text => createHash('sha256').update(String(text)).digest();
const same = (a, b) => timingSafeEqual(digest(a), digest(b));

function cookieOf(header) {
  for (const part of String(header ?? '').split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === COOKIE) return rest.join('=');
  }
  return null;
}

/**
 * @param {{lan: boolean, port: number, key?: string, addresses?: string[], name?: string}} options
 * @returns {{hosts: Set<string>, check: (req: {headers: object, socket: {remoteAddress?: string}}, url: URL) =>
 *   {pass: true} | {redirect: string, cookie: string} | {ask: true, wrong: boolean}}}
 */
export function createAccess({ lan, port, key, addresses = lanAddresses(), name = hostname() }) {
  // The names the monitor answers to. A request under any other name is refused: a web page
  // elsewhere that points its own name at this machine (DNS rebinding) gets nothing.
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  if (lan) {
    for (const address of addresses) hosts.add(`${address}:${port}`);
    if (name) for (const n of [name, `${name}.local`]) hosts.add(`${n.toLowerCase()}:${port}`);
  }

  function check(req, url) {
    if (!lan || isLoopback(req.socket.remoteAddress)) return { pass: true };
    const given = url.searchParams.get('key');
    if (given != null) {
      if (!same(given, key)) return { ask: true, wrong: true };
      // Remembered on that device, and the key taken out of the address it is left at.
      const rest = new URLSearchParams(url.searchParams);
      rest.delete('key');
      const query = rest.toString();
      return {
        redirect: query ? `${url.pathname}?${query}` : url.pathname,
        cookie: `${COOKIE}=${key}; Max-Age=${YEAR}; Path=/; HttpOnly; SameSite=Strict`,
      };
    }
    const kept = cookieOf(req.headers.cookie);
    return kept != null && same(kept, key) ? { pass: true } : { ask: true, wrong: false };
  }

  return { hosts, check };
}

/** The policy of the page that asks for the key: nothing but its own style and its own form. */
export const ASK_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

/** The page a device without the key is shown. It says where the key is, never what it is. */
export function askPage(wrong) {
  const note = wrong
    ? '<p class="wrong">That key is not the right one. · รหัสนี้ไม่ถูกต้อง</p>'
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>OpenCode Monitor</title>
<style>
:root { color-scheme: light dark; --bg: #f5f6f9; --card: #fff; --fg: #161b26; --muted: #5d6676; --line: #d9dde6; --accent: #2f6fdb; --wrong: #c0392b; }
@media (prefers-color-scheme: dark) { :root { --bg: #12161f; --card: #1a202c; --fg: #e9ecf3; --muted: #9aa3b2; --line: #2c3444; --accent: #7fb0ff; --wrong: #ff7a8a; } }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100dvh; display: grid; place-items: center; padding: 16px; background: var(--bg); color: var(--fg); font: 16px/1.6 system-ui, sans-serif; }
main { width: 100%; max-width: 26rem; padding: 24px; border: 1px solid var(--line); border-radius: 12px; background: var(--card); }
h1 { margin: 0 0 8px; font-size: 1.25rem; line-height: 1.3; }
p { margin: 0 0 12px; color: var(--muted); font-size: 0.875rem; }
.wrong { color: var(--wrong); }
label { display: block; margin: 16px 0 6px; font-size: 0.875rem; }
input { width: 100%; height: 40px; padding: 0 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); color: var(--fg); font: inherit; }
button { width: 100%; height: 40px; margin-top: 12px; border: 0; border-radius: 8px; background: var(--accent); color: var(--bg); font: inherit; font-weight: 600; cursor: pointer; }
input:focus-visible, button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
code { font-family: ui-monospace, Consolas, monospace; font-size: 0.8125rem; }
</style>
</head>
<body>
<main>
<h1>OpenCode Monitor</h1>
<p>This monitor is on another machine. It shows what an agent there is doing, so it asks for an access key once on each device.</p>
<p>monitor นี้อยู่บนอีกเครื่องหนึ่ง และแสดงสิ่งที่ agent บนเครื่องนั้นกำลังทำ จึงขอรหัสเข้าถึงหนึ่งครั้งต่ออุปกรณ์</p>
${note}
<form method="get" action="/">
<label for="key">Access key · รหัสเข้าถึง</label>
<input id="key" name="key" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" required autofocus>
<button type="submit">Open · เปิด</button>
</form>
<p style="margin: 16px 0 0">On the machine that runs the monitor: <code>node server.mjs --access-key</code></p>
</main>
</body>
</html>
`;
}
