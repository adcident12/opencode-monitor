// Is an OpenCode process alive? Without this, a session that was mid-tool when OpenCode
// crashed would look "stuck" forever.
import { execFile } from 'node:child_process';
import { TASKLIST } from './programs.mjs';
import { fields } from './text.mjs';

function list() {
  return new Promise((resolve, reject) => {
    const [cmd, args] = process.platform === 'win32'
      ? [TASKLIST, ['/FO', 'CSV', '/NH']]
      : ['ps', ['-A', '-o', 'pid=,args=']];
    execFile(cmd, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 8000 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

export function matchProcesses(output, names, platform = process.platform, ownPid = process.pid) {
  const wanted = new Set(names.map(n => n.toLowerCase()));
  for (const line of output.split('\n')) {
    if (platform === 'win32') {
      const image = /^"([^"]+)"/.exec(line)?.[1]?.toLowerCase().replace(/\.exe$/, '');
      if (image && wanted.has(image)) return true;
    } else {
      const m = fields(line, 1);
      if (!m || !/^\d+$/.test(m[0]) || Number(m[0]) === ownPid) continue;
      // Match the program or script name, not a directory that merely contains the word.
      const words = m[1].toLowerCase().split(/\s+/).slice(0, 2).map(w => w.split('/').pop());
      if (words.some(w => wanted.has(w))) return true;
    }
  }
  return false;
}

/**
 * running: true / false / null (not checked yet or the check itself failed).
 * Gone only when two lists in a row do not have it: one list without it, while OpenCode ran on,
 * was seen once on a busy machine, and every working session was then shown as "OpenCode
 * closed" for ten seconds and recorded so in the history.
 */
export function createProcessProbe(names, { enabled = true, everyMs = 10_000, run = list } = {}) {
  const probe = { running: enabled ? null : true, refresh: async () => {} };
  if (!enabled) return probe;
  let last = 0;
  let busy = false;
  let missed = 0;
  probe.refresh = async () => {
    if (busy || Date.now() - last < everyMs) return;
    busy = true;
    try {
      const found = matchProcesses(await run(), names);
      missed = found ? 0 : missed + 1;
      if (found) probe.running = true;
      else if (missed >= 2) probe.running = false;
    } catch {
      probe.running = null;
    } finally {
      last = Date.now();
      busy = false;
    }
  };
  return probe;
}
