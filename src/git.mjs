// Current branch of each project directory, cached and refreshed in the background.
//
// A project directory is not trusted: the agent can write anything inside it, .git included.
// So this file does as little as it can there.
//
// - git is never executed. git runs programs named in a repository's config (filters,
//   fsmonitor, gpg.program, remote helpers).
// - Exactly one file is read per repository: .git/HEAD, at most a few kilobytes, at a path
//   built only from the project directory and two fixed names. Nothing read from the
//   repository is ever used as a path, so there are no pointers to follow. A worktree or
//   submodule, whose .git is a file pointing elsewhere, is reported as unreadable rather
//   than followed.
// - The work per refresh is bounded: one short walk up the parents and one small read per
//   directory, with a time limit.
// - Not being able to read is a state of its own. "No repository", "unreadable" and a
//   branch name are kept apart, and a result that has gone stale becomes "unreadable".
//
// Earlier versions also listed commits by reading the reflog and ref files. That meant
// walking a directory tree the agent controls, and every hardening of it left another gap,
// so it was removed. Commits and uncommitted changes are therefore not shown.
//
// Known limit: between checking that .git and HEAD are a real directory and a real file and
// opening HEAD, something that is actively racing the monitor could swap one for a link.
// Node cannot open a path relative to a directory handle, so that window cannot be closed
// here; O_NOFOLLOW covers the last step where the platform has it, and the open file is
// compared with what was checked. What is read is only ever parsed as a branch name.
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';

const HEAD_MAX_BYTES = 4096;
const MAX_PARENTS = 64;
const INSPECT_TIMEOUT_MS = 3000;
const DEVICE_NAME = /^(?:CON|PRN|AUX|NUL|COM[0-9\u00b9\u00b2\u00b3]|LPT[0-9\u00b9\u00b2\u00b3]|CONIN\$|CONOUT\$)(?:\..*)?$/i;

class Unreadable extends Error {}

/** One path component we are willing to pass through. */
export function isSafeSegment(name) {
  if (typeof name !== 'string' || !name || name === '.' || name === '..') return false;
  // Separators, drive or stream markers, wildcards, control characters.
  if (/[\\/:*?"<>|\u0000-\u001f]/.test(name)) return false;
  // Windows strips trailing dots and spaces, turning "NUL." or "aux " into device names.
  if (/[. ]$/.test(name)) return false;
  return !DEVICE_NAME.test(name);
}

/** An absolute path on a local disk: no network share, no device namespace. */
export function isSafeLocalPath(path) {
  if (typeof path !== 'string' || !path || !isAbsolute(path)) return false;
  if (/^[\\/]{2}/.test(path)) return false; // \\server\share, //server/share, \\?\, \\.\
  if (/^\/(?:dev|proc|sys)(?:\/|$)/.test(path)) return false;
  const { root } = parse(path);
  if (!(root === '/' || /^[A-Za-z]:[\\/]$/.test(root))) return false;
  return path.slice(root.length).split(/[\\/]+/).filter(Boolean).every(isSafeSegment);
}

/** Accepts only the two forms git itself writes; anything else yields no branch. */
export function parseHead(text) {
  const ref = /^ref: refs\/heads\/([^\s\u0000-\u001f]{1,250})\n?$/.exec(text)?.[1];
  if (ref) return { branch: ref, detached: false };
  const hash = /^([0-9a-f]{40}(?:[0-9a-f]{24})?)\n?$/i.exec(text)?.[1];
  return hash ? { branch: hash.slice(0, 7), detached: true } : { branch: null, detached: false };
}

// Reads <gitDir>/HEAD if it is a small regular file. Throws Unreadable otherwise.
async function readHead(gitDir) {
  const path = join(gitDir, 'HEAD');
  const before = await lstat(path).catch(() => null);
  if (!before?.isFile() || before.size > HEAD_MAX_BYTES) throw new Unreadable('HEAD is not a small regular file');
  // O_NOFOLLOW: refuse to open if HEAD became a link since the check (not available on Windows).
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(() => null);
  if (!file) throw new Unreadable('HEAD could not be opened');
  try {
    const opened = await file.stat();
    const sameFile = opened.dev === before.dev && opened.ino === before.ino;
    if (!opened.isFile() || opened.size > HEAD_MAX_BYTES || !sameFile) throw new Unreadable('HEAD changed while being read');
    const { buffer, bytesRead } = await file.read(Buffer.alloc(HEAD_MAX_BYTES), 0, HEAD_MAX_BYTES, 0);
    return buffer.toString('utf8', 0, bytesRead);
  } finally {
    await file.close();
  }
}

/**
 * @returns {Promise<{branch: string|null, detached: boolean}|null>} null when no parent of
 *   `dir` holds a .git; throws Unreadable when one does but it will not be read.
 */
async function inspect(dir) {
  if (!isSafeLocalPath(dir)) throw new Unreadable('not a local path');
  let current = resolve(dir);
  for (let depth = 0; depth < MAX_PARENTS; depth++) {
    const dotGit = join(current, '.git');
    const info = await lstat(dotGit).catch(() => null);
    if (info?.isDirectory()) return parseHead(await readHead(dotGit));
    // A file here is a worktree or submodule pointer, a link is anyone's guess: not followed.
    if (info) throw new Unreadable('.git is not a plain directory');
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  throw new Unreadable('too many parent directories');
}

/** What is reported when a repository exists but was not read: nothing is claimed. */
export const UNREADABLE = Object.freeze({ branch: null, detached: false, state: 'unreadable' });

export function createGitProbe({ enabled = true, everyMs = 15_000, now = () => Date.now() } = {}) {
  const cache = new Map(); // directory -> { at, info } where info is null for "no repository"
  let last = 0;
  let busy = false;

  async function refresh(dirs) {
    if (!enabled || busy || now() - last < everyMs) return;
    busy = true;
    try {
      const wanted = new Set(dirs.filter(Boolean));
      await Promise.all([...wanted].map(async dir => {
        let timer;
        const timeout = new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Unreadable('timed out')), INSPECT_TIMEOUT_MS);
        });
        // Any failure, expected or not, is "unreadable". Only reaching the drive root
        // without finding .git is "no repository".
        const info = await Promise.race([inspect(dir).then(found => found && { ...found, state: 'ok' }), timeout]).catch(() => UNREADABLE);
        clearTimeout(timer);
        cache.set(dir, { at: now(), info });
      }));
      for (const dir of cache.keys()) if (!wanted.has(dir)) cache.delete(dir);
    } finally {
      last = now();
      busy = false;
    }
  }

  /**
   * @returns {object|null|undefined} { branch, detached, state }; null when the directory is
   *   not in a repository; undefined when it has not been looked at yet. A result that has
   *   not been refreshed for several intervals is no longer vouched for: UNREADABLE.
   */
  function get(dir) {
    const entry = cache.get(dir);
    if (!entry) return undefined;
    return now() - entry.at > everyMs * 4 ? UNREADABLE : entry.info;
  }

  return { refresh, get };
}
