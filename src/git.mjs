// Current branch and recent commits of each project directory, cached and refreshed in
// the background.
//
// A project directory is not trusted: the agent can write anything inside it, .git included.
// Three consequences shape this file.
//
// 1. git is never executed. git runs programs named in a repository's config (filters,
//    fsmonitor, gpg.program, remote helpers). Instead two plain files are read: HEAD for the
//    branch and logs/HEAD (the reflog) for commits made in this clone. That is also why
//    uncommitted changes are not shown: working that out needs git.
//
// 2. Nothing inside the repository decides where we read. Every file is reached by walking
//    down from a directory we already hold, one name at a time, checking each step without
//    following it: a link or junction anywhere on the way is refused, so a `.git/logs` that
//    points at a network share or a device is never opened. Names are fixed by this file
//    or validated one segment at a time; text from the repository is never used as a path,
//    except the worktree pointer, which gets the same step-by-step walk from the drive root.
//
// 3. Not being able to read is a state of its own. "No repository here", "could not be read"
//    and "read fine" are kept apart, and results that have gone stale are reported as
//    unreadable, so a failure can never look like a clean repository.
//
// What this cannot be: an integrity check. Whoever can write the reflog can write a
// consistent fake one. The checks catch a reflog that is missing, cut, or stale; they do
// not prove the record is honest.
import { lstat, open, readdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';

const REFLOG_TAIL_BYTES = 256 * 1024;
const SMALL_FILE_BYTES = 64 * 1024;
const PACKED_REFS_BYTES = 8 * 1024 * 1024;
const MAX_COMMITS = 50;
const INSPECT_TIMEOUT_MS = 5000;
const HASH = '[0-9a-f]{40}(?:[0-9a-f]{24})?';
const DEVICE_NAME = /^(?:CON|PRN|AUX|NUL|COM[0-9\u00b9\u00b2\u00b3]|LPT[0-9\u00b9\u00b2\u00b3]|CONIN\$|CONOUT\$)(?:\..*)?$/i;

class Unreadable extends Error {}

/** One path component we are willing to step into or open. */
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

// Walks from `root` down through `names` without following anything: every step must be a
// real directory, never a link. Returns the final path, or null if any step is refused.
async function descend(root, names) {
  let current = root;
  for (const name of names) {
    if (!isSafeSegment(name)) return null;
    const info = await lstat(current).catch(() => null);
    if (!info?.isDirectory()) return null;
    current = join(current, name);
  }
  return current;
}

// Reads a regular file under `root` (not a link, pipe, or device) of at most `max` bytes,
// or its last `max` bytes when `tail` is set. null when it is absent or refused.
async function readUnder(root, names, max, { tail = false } = {}) {
  const path = await descend(root, names);
  if (!path) return null;
  const info = await lstat(path).catch(() => null);
  if (!info?.isFile() || (info.size > max && !tail)) return null;
  const file = await open(path, 'r').catch(() => null);
  if (!file) return null;
  try {
    // Checked again on the open handle, in case the path was swapped after the first look.
    const opened = await file.stat();
    if (!opened.isFile() || (opened.size > max && !tail)) return null;
    const length = Math.min(opened.size, max);
    const start = opened.size - length;
    const { buffer, bytesRead } = await file.read(Buffer.alloc(length), 0, length, start);
    const text = buffer.toString('utf8', 0, bytesRead);
    // Drop the first line if the read began in the middle of it.
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
  } finally {
    await file.close();
  }
}

// A directory reached from the drive root without passing through any link.
async function isPlainDirFromRoot(path) {
  if (!isSafeLocalPath(path)) return false;
  const { root } = parse(path);
  const names = path.slice(root.length).split(/[\\/]+/).filter(Boolean);
  const reached = await descend(root, names);
  return Boolean(reached) && Boolean((await lstat(reached).catch(() => null))?.isDirectory());
}

/**
 * Finds the git directory for a project directory, which may sit below the repository root.
 * @returns {Promise<string|null>} null when there is no repository; throws Unreadable when
 *   there is one but it is laid out in a way this file refuses to follow.
 */
async function gitDirOf(dir) {
  if (!isSafeLocalPath(dir)) throw new Unreadable('not a local path');
  for (let current = resolve(dir); ; current = dirname(current)) {
    const dotGit = join(current, '.git');
    const info = await lstat(dotGit).catch(() => null);
    if (info?.isDirectory()) return dotGit;
    if (info?.isFile()) {
      // Worktrees and submodules have a .git file pointing at <repo>/.git/worktrees/<name>
      // or <repo>/.git/modules/<name>. Nothing else is accepted as a target.
      const pointer = /^gitdir:\s*(.+)$/m.exec((await readUnder(current, ['.git'], SMALL_FILE_BYTES)) ?? '')?.[1]?.trim();
      if (!pointer || /^[\\/]{2}/.test(pointer)) throw new Unreadable('unsupported .git pointer');
      const target = isAbsolute(pointer) ? resolve(pointer) : resolve(current, pointer);
      const names = target.split(/[\\/]+/);
      const shape = names.at(-3) === '.git' && (names.at(-2) === 'worktrees' || names.at(-2) === 'modules');
      if (!shape || !(await isPlainDirFromRoot(target))) throw new Unreadable('unsupported .git pointer');
      return target;
    }
    if (info) throw new Unreadable('.git is neither a directory nor a file');
    if (dirname(current) === current) return null;
  }
}

// Where branches live: the git dir itself, or for a worktree the main repository's .git.
// git writes "../.." into `commondir` for that; any other content is refused, not guessed at.
async function commonDirOf(gitDir) {
  const text = (await readUnder(gitDir, ['commondir'], SMALL_FILE_BYTES))?.trim();
  if (text == null) {
    if (await lstat(join(gitDir, 'commondir')).catch(() => null)) throw new Unreadable('commondir is not a plain file');
    return gitDir;
  }
  const common = resolve(gitDir, '..', '..');
  if (resolve(gitDir, text) !== common || !common.endsWith(`${sep}.git`)) throw new Unreadable('unexpected commondir');
  return common;
}

export function parseHead(text) {
  const ref = /^ref:\s*refs\/heads\/(.+)$/m.exec(text)?.[1]?.trim();
  if (ref) return { branch: ref, detached: false };
  const hash = new RegExp(`^${HASH}$`, 'i').exec(text.trim())?.[0];
  return hash ? { branch: hash.slice(0, 7), detached: true } : { branch: null, detached: false };
}

// <old> <new> Name <email> <seconds> <zone>\t<action>: <subject>
const REFLOG_ENTRY = new RegExp(`^(${HASH}) (${HASH}) .*> (\\d+) [+-]\\d{4}\\t(.*)$`, 'i');
const COMMIT_ACTION = /^(?:commit(?: \([^)]*\))?|merge [^:]*|cherry-pick|revert): (.*)$/;

/**
 * @returns {{
 *   commits: {hash: string, at: number, subject: string}[],  newest first
 *   last: string|null,     hash the reflog says HEAD moved to last
 *   intact: boolean        every entry starts where the previous one ended, and every line parsed
 * }}
 */
export function parseReflog(text) {
  const commits = [];
  let last = null;
  let intact = true;
  for (const line of text.split('\n')) {
    if (!line) continue;
    const m = REFLOG_ENTRY.exec(line);
    if (!m) {
      intact = false;
      continue;
    }
    const [, from, to, seconds, action] = m;
    // A removed line leaves a gap: the next entry no longer starts at the previous hash.
    if (last && from.toLowerCase() !== last) intact = false;
    last = to.toLowerCase();
    const subject = COMMIT_ACTION.exec(action)?.[1];
    if (subject != null) commits.push({ hash: last.slice(0, 7), at: Number(seconds) * 1000, subject });
  }
  return { commits: commits.reverse().slice(0, MAX_COMMITS), last, intact };
}

// Is there any branch at all? Tells a brand-new repository from one whose refs cannot be
// read. Anything unclear counts as "yes", which leads to "unreliable", not to "fine".
async function hasAnyBranch(commonDir) {
  const packed = await readUnder(commonDir, ['packed-refs'], PACKED_REFS_BYTES);
  if (packed != null) {
    if (new RegExp(`^${HASH} refs/heads/`, 'mi').test(packed)) return true;
  } else if (await lstat(join(commonDir, 'packed-refs')).catch(() => null)) {
    return true;
  }
  const walk = async (names, depth) => {
    const path = await descend(commonDir, names);
    // A step that was refused (a link, say) or cannot be examined is not "empty".
    if (!path) return true;
    const info = await lstat(path).catch(() => null);
    if (!info) return depth > 0; // a new repository always has refs/heads itself
    if (!info.isDirectory()) return true;
    for (const entry of await readdir(path, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory() || depth >= 8) return true;
      if (await walk([...names, entry.name], depth + 1)) return true;
    }
    return false;
  };
  return walk(['refs', 'heads'], 0);
}

// The commit HEAD points at now, read from the ref files. null when it cannot be determined.
async function headHash(gitDir, commonDir, headText) {
  const direct = new RegExp(`^${HASH}$`, 'i').exec(headText.trim())?.[0];
  if (direct) return direct.toLowerCase();
  const ref = /^ref:\s*(refs\/\S+)\s*$/m.exec(headText)?.[1];
  const names = ref?.split('/');
  if (!names || !names.every(isSafeSegment)) return null;
  for (const base of new Set([gitDir, commonDir])) {
    const loose = (await readUnder(base, names, SMALL_FILE_BYTES))?.trim();
    if (loose && new RegExp(`^${HASH}$`, 'i').test(loose)) return loose.toLowerCase();
  }
  const packed = (await readUnder(commonDir, ['packed-refs'], PACKED_REFS_BYTES)) ?? '';
  for (const line of packed.split('\n')) {
    if (line.endsWith(` ${ref}`) && new RegExp(`^${HASH} `, 'i').test(line)) return line.slice(0, line.indexOf(' ')).toLowerCase();
  }
  return null;
}

/**
 * Can the reflog be shown as the list of commits? Anything short of a clean match is
 * reported as not reliable; the only empty state accepted as fine is a repository that
 * has no branch yet.
 *   ok       - the reflog is unbroken and ends at the commit HEAD points at now
 *   missing  - there is no reflog to read
 *   mismatch - the reflog has gaps, unreadable lines, or does not end at the current commit,
 *              or the current commit could not be determined
 */
export function historyState({ head, reflog, unborn }) {
  if (!reflog.last) return unborn && !head ? 'ok' : 'missing';
  if (!head || !reflog.intact) return 'mismatch';
  return head === reflog.last ? 'ok' : 'mismatch';
}

/** What is shown when a repository exists but could not be read: nothing is claimed. */
export const UNREADABLE = Object.freeze({ branch: null, detached: false, commits: [], history: 'unreadable' });

async function inspect(dir) {
  const gitDir = await gitDirOf(dir);
  if (!gitDir) return null;
  const headText = await readUnder(gitDir, ['HEAD'], SMALL_FILE_BYTES);
  if (headText == null) throw new Unreadable('no readable HEAD');
  const commonDir = await commonDirOf(gitDir);
  const reflog = parseReflog((await readUnder(gitDir, ['logs', 'HEAD'], REFLOG_TAIL_BYTES, { tail: true })) ?? '');
  const head = await headHash(gitDir, commonDir, headText);
  const parsed = parseHead(headText);
  // "No commits yet" is only believed for a well-formed HEAD in a repository with no branch.
  const unborn = !head && Boolean(parsed.branch) && !parsed.detached && !(await hasAnyBranch(commonDir));
  return { ...parsed, commits: reflog.commits, history: historyState({ head, reflog, unborn }) };
}

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
        // Any failure, expected or not, is "unreadable". Only a clean walk to the drive
        // root without finding .git is "no repository".
        const info = await Promise.race([inspect(dir), timeout]).catch(() => UNREADABLE);
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
   * @returns {object|null|undefined} repository info; null when the directory is not in a
   *   repository; undefined when it has not been looked at yet. A result that has not been
   *   refreshed for several intervals is no longer trusted and comes back as UNREADABLE.
   */
  function get(dir) {
    const entry = cache.get(dir);
    if (!entry) return undefined;
    return now() - entry.at > everyMs * 4 ? UNREADABLE : entry.info;
  }

  return { refresh, get };
}
