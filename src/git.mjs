// Branch, uncommitted changes, and recent commits of each project directory.
// Only read-only git commands, run in the background and cached.
import { execFile } from 'node:child_process';

// --no-optional-locks: do not touch the index while the agent may be using it.
// core.fsmonitor=false: a repository's own config must not make us run a hook program.
const BASE = ['--no-optional-locks', '-c', 'core.fsmonitor=false'];

function git(dir, args) {
  return new Promise(resolve => {
    execFile('git', ['-C', dir, ...BASE, ...args], { windowsHide: true, timeout: 8000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => resolve(err ? null : stdout));
  });
}

export function parseStatus(out) {
  const info = { branch: null, ahead: 0, behind: 0, dirty: 0 };
  for (const line of out.split('\n')) {
    if (line.startsWith('# branch.head ')) info.branch = line.slice(14).trim();
    else if (line.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(line);
      if (m) [info.ahead, info.behind] = [Number(m[1]), Number(m[2])];
    } else if (line && !line.startsWith('#')) info.dirty++;
  }
  return info;
}

export function parseLog(out) {
  return out.split('\n').filter(Boolean).map(line => {
    const [hash, seconds, ...subject] = line.split('\t');
    return { hash, at: Number(seconds) * 1000, subject: subject.join('\t') };
  });
}

export function createGitProbe({ enabled = true, everyMs = 15_000 } = {}) {
  const cache = new Map(); // directory -> info | null (not a repository / git missing)
  let last = 0;
  let busy = false;

  async function refresh(dirs) {
    if (!enabled || busy || Date.now() - last < everyMs) return;
    busy = true;
    try {
      const wanted = new Set(dirs.filter(Boolean));
      await Promise.all([...wanted].map(async dir => {
        const status = await git(dir, ['status', '--porcelain=v2', '--branch']);
        if (status == null) return cache.set(dir, null);
        const log = await git(dir, ['log', '-n', '50', '--format=%h%x09%ct%x09%s']);
        cache.set(dir, { ...parseStatus(status), commits: log ? parseLog(log) : [] });
      }));
      for (const dir of cache.keys()) if (!wanted.has(dir)) cache.delete(dir);
    } finally {
      last = Date.now();
      busy = false;
    }
  }

  return { refresh, get: dir => cache.get(dir) ?? null };
}
