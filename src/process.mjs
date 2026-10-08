// Is an OpenCode process alive? Without this, a session that was mid-tool when OpenCode
// crashed would look "stuck" forever.
import { execFile } from 'node:child_process';

function list() {
  return new Promise((resolve, reject) => {
    const [cmd, args] = process.platform === 'win32'
      ? ['tasklist', ['/FO', 'CSV', '/NH']]
      : ['ps', ['-A', '-o', 'pid=,args=']];
    execFile(cmd, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 8000 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

export function matchProcesses(output, names, platform = process.platform, ownPid = process.pid) {
  const wanted = names.map(n => n.toLowerCase());
  for (const line of output.split('\n')) {
    if (platform === 'win32') {
      const image = /^"([^"]+)"/.exec(line)?.[1]?.toLowerCase().replace(/\.exe$/, '');
      if (image && wanted.includes(image)) return true;
    } else {
      const m = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (!m || Number(m[1]) === ownPid) continue;
      // Match the program or script name, not a directory that merely contains the word.
      const words = m[2].toLowerCase().split(/\s+/).slice(0, 2).map(w => w.split('/').pop());
      if (words.some(w => wanted.includes(w))) return true;
    }
  }
  return false;
}

/** running: true / false / null (not checked yet or the check itself failed). */
export function createProcessProbe(names, { enabled = true, everyMs = 10_000 } = {}) {
  const probe = { running: enabled ? null : true, refresh: async () => {} };
  if (!enabled) return probe;
  let last = 0;
  let busy = false;
  probe.refresh = async () => {
    if (busy || Date.now() - last < everyMs) return;
    busy = true;
    try {
      probe.running = matchProcesses(await list(), names);
    } catch {
      probe.running = null;
    } finally {
      last = Date.now();
      busy = false;
    }
  };
  return probe;
}
