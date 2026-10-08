// Current branch and recent commits of each project directory, cached and refreshed in
// the background.
//
// A project directory is not trusted: the agent can write anything inside it, .git included.
// Two consequences shape this file.
//
// 1. git is never executed. git runs programs named in a repository's config (filters,
//    fsmonitor, gpg.program, remote helpers). Instead two plain files are read: HEAD for the
//    branch and logs/HEAD (the reflog) for commits made in this clone. That is also why
//    uncommitted changes are not shown: working that out needs git.
//
// 2. Paths found inside the repository are not followed blindly. A `.git` file or a
//    `commondir` file can name any path; on Windows a network path there would make this
//    process authenticate to a remote machine, and a device or pipe would hang it. Every
//    path is checked as text first, and only regular files of bounded size are read.
//
// What this cannot be: an integrity check. Whoever can write the reflog can write a
// consistent fake one. The checks below catch a reflog that is missing, cut, or stale, so
// that "no record" is never shown as "no commits"; they do not prove the record is honest.
import { lstat, open, readdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const REFLOG_TAIL_BYTES = 256 * 1024;
const SMALL_FILE_BYTES = 64 * 1024;
const PACKED_REFS_BYTES = 8 * 1024 * 1024;
const MAX_COMMITS = 50;
const HASH = '[0-9a-f]{40}(?:[0-9a-f]{24})?';

/** Network shares, device namespaces, and kernel filesystems are never touched. */
export function isSafeLocalPath(path) {
  if (typeof path !== 'string' || !path || path.includes('\0')) return false;
  if (/^[\\/]{2}/.test(path)) return false; // \\server\share, //server/share, \\?\, \\.\
  if (/^\/(?:dev|proc|sys)(?:\/|$)/.test(path)) return false;
  // Windows device names are special in every directory: C:\x\NUL, COM1, ...
  if (/(?:^|[\\/])(?:CON|PRN|AUX|NUL|COM\d|LPT\d)(?:\.[^\\/]*)?$/i.test(path)) return false;
  return isAbsolute(path);
}

const isInside = (parent, child) => {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

// Reads a regular file (not a link, pipe, or device) of at most `max` bytes; from the end
// if it is longer and `tail` is set. null for anything else.
async function readPlain(path, max, { tail = false } = {}) {
  if (!isSafeLocalPath(path)) return null;
  const info = await lstat(path).catch(() => null);
  if (!info?.isFile()) return null;
  if (info.size > max && !tail) return null;
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

const isPlainDir = async path => isSafeLocalPath(path) && Boolean((await lstat(path).catch(() => null))?.isDirectory());

// The repository may be a parent of the session's directory.
async function gitDirOf(dir) {
  if (!isSafeLocalPath(dir)) throw new Error('not a local path');
  for (let current = resolve(dir); ; current = dirname(current)) {
    const dotGit = join(current, '.git');
    const info = await lstat(dotGit).catch(() => null);
    if (info?.isDirectory()) return dotGit;
    if (info?.isFile()) {
      // Worktrees and submodules have a .git file pointing at <repo>/.git/worktrees/<name>
      // or <repo>/.git/modules/<name>. Anything else it might point at is refused.
      const pointer = /^gitdir:\s*(.+)$/m.exec((await readPlain(dotGit, SMALL_FILE_BYTES)) ?? '')?.[1]?.trim();
      const target = pointer && (isAbsolute(pointer) ? resolve(pointer) : resolve(current, pointer));
      if (!target || !/[\\/]\.git[\\/](?:worktrees|modules)[\\/][^\\/]+/.test(target) || !(await isPlainDir(target))) {
        throw new Error('unsupported .git pointer');
      }
      return target;
    }
    if (info || dirname(current) === current) throw new Error('not a repository');
  }
}

// Where branches live: the git dir itself, or for a worktree the main repository's .git,
// named by `commondir`. Only a parent of the git dir that is itself a ".git" is accepted.
async function commonDirOf(gitDir) {
  const text = (await readPlain(join(gitDir, 'commondir'), SMALL_FILE_BYTES))?.trim();
  if (!text) return gitDir;
  const common = resolve(gitDir, text);
  return common.endsWith(`${sep}.git`) && isInside(common, gitDir) && (await isPlainDir(common)) ? common : gitDir;
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

// Is there any branch at all? Used to tell a brand-new repository from one whose refs
// cannot be read.
async function hasAnyBranch(commonDir) {
  const packed = await readPlain(join(commonDir, 'packed-refs'), PACKED_REFS_BYTES);
  if (packed == null ? (await lstat(join(commonDir, 'packed-refs')).catch(() => null)) != null : new RegExp(`^${HASH} refs/heads/`, 'mi').test(packed)) return true;
  const walk = async (path, depth) => {
    for (const entry of await readdir(path, { withFileTypes: true }).catch(() => [])) {
      if (entry.isFile() || entry.isSymbolicLink()) return true;
      if (entry.isDirectory() && depth < 8 && (await walk(join(path, entry.name), depth + 1))) return true;
    }
    return false;
  };
  return walk(join(commonDir, 'refs', 'heads'), 0);
}

// The commit HEAD points at now, read from the ref files. null when it cannot be determined.
async function headHash(gitDir, commonDir, headText) {
  const direct = new RegExp(`^${HASH}$`, 'i').exec(headText.trim())?.[0];
  if (direct) return direct.toLowerCase();
  const ref = /^ref:\s*(refs\/[\w./-]+)\s*$/m.exec(headText)?.[1];
  if (!ref || ref.split('/').some(part => part === '..' || part === '.' || part === '')) return null;
  for (const base of new Set([gitDir, commonDir])) {
    const loose = (await readPlain(join(base, ...ref.split('/')), SMALL_FILE_BYTES))?.trim();
    if (loose && new RegExp(`^${HASH}$`, 'i').test(loose)) return loose.toLowerCase();
  }
  const packed = (await readPlain(join(commonDir, 'packed-refs'), PACKED_REFS_BYTES)) ?? '';
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

export function createGitProbe({ enabled = true, everyMs = 15_000 } = {}) {
  const cache = new Map(); // directory -> info | null (not a repository we can read)
  let last = 0;
  let busy = false;

  async function inspect(dir) {
    const gitDir = await gitDirOf(dir);
    const headText = await readPlain(join(gitDir, 'HEAD'), SMALL_FILE_BYTES);
    if (headText == null) throw new Error('no HEAD');
    const commonDir = await commonDirOf(gitDir);
    const reflog = parseReflog((await readPlain(join(gitDir, 'logs', 'HEAD'), REFLOG_TAIL_BYTES, { tail: true })) ?? '');
    const head = await headHash(gitDir, commonDir, headText);
    const parsed = parseHead(headText);
    // "No commits yet" is only believed for a well-formed HEAD in a repository with no branch.
    const unborn = !head && Boolean(parsed.branch) && !parsed.detached && !(await hasAnyBranch(commonDir));
    return { ...parsed, commits: reflog.commits, history: historyState({ head, reflog, unborn }) };
  }

  async function refresh(dirs) {
    if (!enabled || busy || Date.now() - last < everyMs) return;
    busy = true;
    try {
      const wanted = new Set(dirs.filter(Boolean));
      await Promise.all([...wanted].map(async dir => cache.set(dir, await inspect(dir).catch(() => null))));
      for (const dir of cache.keys()) if (!wanted.has(dir)) cache.delete(dir);
    } finally {
      last = Date.now();
      busy = false;
    }
  }

  return { refresh, get: dir => cache.get(dir) ?? null };
}
