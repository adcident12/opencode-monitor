// Serves the built page (public/, produced by dashboard/) and the shared UI strings (i18n/).
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

/**
 * The page is pre-rendered, so its inline scripts are fixed. Allowing exactly those, by
 * hash, keeps 'unsafe-inline' out of script-src: nothing injected into the page could run.
 */
export function contentSecurityPolicy(html) {
  const hashes = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
    .map(m => `'sha256-${createHash('sha256').update(m[1], 'utf8').digest('base64')}'`);
  return [
    "default-src 'self'",
    `script-src 'self' ${[...new Set(hashes)].join(' ')}`.trim(),
    // Inline style attributes come from React (progress bars) and the component library.
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join('; ');
}

/** Maps a URL path to a file under `dir`, or null. Never leaves `dir`. */
export function resolveUnder(dir, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  const relative = normalize(decoded).replace(/^[/\\]+/, '');
  if (relative.split(/[/\\]/).some(part => part === '..')) return null;
  const file = join(dir, relative);
  return file === dir || file.startsWith(dir + sep) ? file : null;
}

export function createStatic(root) {
  const publicDir = join(root, 'public');
  const i18nDir = join(root, 'i18n');
  // The policy follows the HTML file it is sent with, recomputed when the page is rebuilt
  // while the monitor runs; a stale hash list would block the new page's scripts.
  const policies = new Map(); // file -> { mtime, csp }
  function cspFor(file) {
    try {
      const { mtimeMs } = statSync(file);
      const known = policies.get(file);
      if (known?.mtime === mtimeMs) return known.csp;
      const csp = contentSecurityPolicy(readFileSync(file, 'utf8'));
      policies.set(file, { mtime: mtimeMs, csp });
      return csp;
    } catch {
      return "default-src 'self'";
    }
  }

  // The id of the page build now on disk (dashboard/scripts/publish.mjs writes it). Re-read
  // only when the file changes, since this is asked on every update.
  const buildFile = join(publicDir, 'build.json');
  let build = { mtime: -1, id: null };
  function buildId() {
    try {
      const { mtimeMs } = statSync(buildFile);
      if (mtimeMs !== build.mtime) build = { mtime: mtimeMs, id: String(JSON.parse(readFileSync(buildFile, 'utf8')).id ?? '') || null };
    } catch {
      build = { mtime: -1, id: null };
    }
    return build.id;
  }

  /** @returns {Promise<{body: Buffer, type: string, csp?: string}|null>} */
  async function lookup(path) {
    let file;
    const i18n = /^\/i18n\/([a-z]{2,3})\.json$/.exec(path);
    if (i18n) file = join(i18nDir, `${i18n[1]}.json`);
    else if (path === '/' || path === '/index.html') file = join(publicDir, 'index.html');
    else file = resolveUnder(publicDir, path);
    if (!file) return null;

    const type = TYPES[extname(file).toLowerCase()];
    if (!type) return null;
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) return null;
    return { body: await readFile(file), type, csp: type.startsWith('text/html') ? cspFor(file) : undefined };
  }

  lookup.buildId = buildId;
  return lookup;
}
