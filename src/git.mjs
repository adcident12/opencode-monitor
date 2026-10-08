// Current branch and recent commits of each project directory, cached and refreshed in
// the background.
//
// A project directory is not trusted: the agent can write to its .git/config, and git runs
// programs named there (clean/smudge filters, fsmonitor, gpg.program, ...). So:
//   - the branch is read straight from .git/HEAD, without running git at all;
//   - the only git command used is `log`, which reads history and runs no filters, with the
//     config keys that could still start a program switched off;
//   - `git status` is deliberately not used, because it runs clean filters from the
//     repository's config. That is why uncommitted changes are not shown.
import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

const SAFE_CONFIG = ['-c', 'core.fsmonitor=false', '-c', 'log.showSignature=false', '-c', 'core.pager=cat'];
const SAFE_ENV = { GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0' };

async function gitDirOf(dir) {
  const dotGit = join(dir, '.git');
  const info = await stat(dotGit);
  if (info.isDirectory()) return dotGit;
  // Worktrees and submodules have a .git file that points elsewhere.
  const pointer = /^gitdir:\s*(.+)$/m.exec(await readFile(dotGit, 'utf8'))?.[1]?.trim();
  if (!pointer) throw new Error('not a repository');
  return isAbsolute(pointer) ? pointer : resolve(dir, pointer);
}

export function parseHead(text) {
  const ref = /^ref:\s*refs\/heads\/(.+)$/m.exec(text)?.[1]?.trim();
  if (ref) return { branch: ref, detached: false };
  const hash = /^[0-9a-f]{7,64}$/i.exec(text.trim())?.[0];
  return hash ? { branch: hash.slice(0, 7), detached: true } : { branch: null, detached: false };
}

export function parseLog(out) {
  return out.split('\n').filter(Boolean).map(line => {
    const [hash, seconds, ...subject] = line.split('\t');
    return { hash, at: Number(seconds) * 1000, subject: subject.join('\t') };
  });
}

function recentCommits(dir) {
  return new Promise(resolve => {
    const args = ['-C', dir, ...SAFE_CONFIG, 'log', '-n', '50', '--no-show-signature', '--no-notes', '--format=%h%x09%ct%x09%s'];
    execFile('git', args, { windowsHide: true, timeout: 8000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, ...SAFE_ENV } },
      (err, stdout) => resolve(err ? [] : parseLog(stdout)));
  });
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
          const head = parseHead(await readFile(join(await gitDirOf(dir), 'HEAD'), 'utf8'));
          cache.set(dir, { ...head, commits: await recentCommits(dir) });
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
