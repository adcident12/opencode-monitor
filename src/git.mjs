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
          const head = parseHead(await readFile(join(gitDir, 'HEAD'), 'utf8'));
          // A repository without a reflog simply shows no commits.
          const commits = parseReflog(await readTail(join(gitDir, 'logs', 'HEAD')).catch(() => ''));
          cache.set(dir, { ...head, commits });
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
