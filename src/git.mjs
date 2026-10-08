// Current branch and recent commits of each project directory, cached and refreshed in
// the background.
//
// git is never executed here. A project directory is not trusted: the agent can write to
// its .git/config, and git runs programs named there (clean/smudge filters, fsmonitor,
// gpg.program, remote helpers for lazily fetched objects, ...). Instead two plain files are
// read: .git/HEAD for the branch, and .git/logs/HEAD (the reflog) for commits made in this
// clone. That is also why uncommitted changes are not shown: working that out needs git.
import { open, readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

const REFLOG_TAIL_BYTES = 256 * 1024;
const MAX_COMMITS = 50;

// The repository may be a parent of the session's directory.
async function gitDirOf(dir) {
  for (let current = resolve(dir); ; current = dirname(current)) {
    const dotGit = join(current, '.git');
    const info = await stat(dotGit).catch(() => null);
    if (info?.isDirectory()) return dotGit;
    if (info?.isFile()) {
      // Worktrees and submodules have a .git file that points elsewhere.
      const pointer = /^gitdir:\s*(.+)$/m.exec(await readFile(dotGit, 'utf8'))?.[1]?.trim();
      if (!pointer) throw new Error('not a repository');
      return isAbsolute(pointer) ? pointer : resolve(current, pointer);
    }
    if (dirname(current) === current) throw new Error('not a repository');
  }
}

export function parseHead(text) {
  const ref = /^ref:\s*refs\/heads\/(.+)$/m.exec(text)?.[1]?.trim();
  if (ref) return { branch: ref, detached: false };
  const hash = /^[0-9a-f]{7,64}$/i.exec(text.trim())?.[0];
  return hash ? { branch: hash.slice(0, 7), detached: true } : { branch: null, detached: false };
}

// <old> <new> Name <email> <seconds> <zone>\tcommit: subject
const REFLOG_LINE = /^[0-9a-f]{40,64} ([0-9a-f]{40,64}) .*> (\d+) [+-]\d{4}\t(commit(?: \([^)]*\))?|merge [^:]*|cherry-pick|revert): (.*)$/;

/** Commits recorded in a reflog, newest first. Checkouts, resets, pulls etc. are skipped. */
export function parseReflog(text) {
  const commits = [];
  for (const line of text.split('\n')) {
    const m = REFLOG_LINE.exec(line);
    if (m) commits.push({ hash: m[1].slice(0, 7), at: Number(m[2]) * 1000, subject: m[4] });
  }
  return commits.reverse().slice(0, MAX_COMMITS);
}

/** Hash the reflog says HEAD moved to last, whatever kind of entry that was. */
export function lastReflogHash(text) {
  const lines = text.trimEnd().split('\n');
  return /^[0-9a-f]{40,64} ([0-9a-f]{40,64}) /.exec(lines.at(-1) ?? '')?.[1] ?? null;
}

// The commit HEAD points at now, read from the ref files. null when it cannot be found.
async function headHash(gitDir, headText) {
  const direct = /^[0-9a-f]{40,64}$/i.exec(headText.trim())?.[0];
  if (direct) return direct.toLowerCase();
  const ref = /^ref:\s*(refs\/\S+)/m.exec(headText)?.[1];
  if (!ref) return null;
  // In a worktree, branches live in the main repository, named by the `commondir` file.
  const common = await readFile(join(gitDir, 'commondir'), 'utf8').then(text => resolve(gitDir, text.trim())).catch(() => gitDir);
  for (const base of new Set([gitDir, common])) {
    const loose = await readFile(join(base, ...ref.split('/')), 'utf8').catch(() => null);
    if (loose && /^[0-9a-f]{40,64}/i.test(loose)) return loose.trim().toLowerCase();
  }
  const packed = await readFile(join(common, 'packed-refs'), 'utf8').catch(() => '');
  return new RegExp(`^([0-9a-f]{40,64}) ${ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'mi').exec(packed)?.[1]?.toLowerCase() ?? null;
}

/**
 * Can the reflog be trusted as the list of commits? It is a plain file the agent can delete,
 * and git can be told not to write it. An empty list must never be shown as "no commits"
 * when the truth is "no record":
 *   ok       - the reflog's last entry is the commit HEAD points at now
 *   missing  - no reflog, or it is empty, while the repository does have a commit
 *   mismatch - HEAD has moved in a way the reflog did not record
 */
export function historyState({ head, reflogHash }) {
  if (!reflogHash) return head ? 'missing' : 'ok';
  if (!head) return 'mismatch';
  return head === reflogHash.toLowerCase() ? 'ok' : 'mismatch';
}

async function readTail(path) {
  const file = await open(path, 'r');
  try {
    const { size } = await file.stat();
    const start = Math.max(0, size - REFLOG_TAIL_BYTES);
    const { buffer, bytesRead } = await file.read(Buffer.alloc(size - start), 0, size - start, start);
    const text = buffer.toString('utf8', 0, bytesRead);
    // Drop the first line if the read began in the middle of it.
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
  } finally {
    await file.close();
  }
}

export function createGitProbe({ enabled = true, everyMs = 15_000 } = {}) {
  const cache = new Map(); // directory -> info | null (not a repository)
  let last = 0;
  let busy = false;

  async function refresh(dirs) {
    if (!enabled || busy || Date.now() - last < everyMs) return;
    busy = true;
    try {
      const wanted = new Set(dirs.filter(Boolean));
      await Promise.all([...wanted].map(async dir => {
        try {
          const gitDir = await gitDirOf(dir);
          const headText = await readFile(join(gitDir, 'HEAD'), 'utf8');
          const reflog = await readTail(join(gitDir, 'logs', 'HEAD')).catch(() => '');
          const history = historyState({ head: await headHash(gitDir, headText), reflogHash: lastReflogHash(reflog) });
          cache.set(dir, { ...parseHead(headText), commits: parseReflog(reflog), history });
        } catch {
          cache.set(dir, null);
        }
      }));
      for (const dir of cache.keys()) if (!wanted.has(dir)) cache.delete(dir);
    } finally {
      last = Date.now();
      busy = false;
    }
  }

  return { refresh, get: dir => cache.get(dir) ?? null };
}
