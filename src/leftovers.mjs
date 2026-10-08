// Processes the agent started in the background that are still running: a dev server it
// launched with Start-Process, a `docker compose up -d`, a `nohup` job. Read-only: it lists
// them so you can decide; it never stops anything.
//
// A process cannot be tied to the command that started it with certainty (a detached
// process forgets its parent). The match used here is: started within a minute after a
// background-flagged call, and sharing distinctive words with that command. Its children
// (the node behind an npm, say) come along, since they are what actually holds the port.
import { execFile } from 'node:child_process';

const START_WINDOW_MS = 60_000;
const EARLY_MS = 3_000;
// Words in almost every launch command, which say nothing about which program it was.
const COMMON = new Set(`start process startprocess argumentlist filepath workingdirectory windowstyle hidden nonewwindow passthru
  redirectstandardoutput redirectstandarderror wait sleep seconds cmd exe powershell pwsh bash sh zsh nohup null dev run
  set location cd echo out file log txt json silentlycontinue erroraction force true false the and`.split(/\s+/));
const DISTINCTIVE = new Set(['npm', 'npx', 'pnpm', 'yarn', 'node', 'next', 'vite', 'python', 'uvicorn', 'docker', 'compose', 'php', 'artisan', 'java', 'dotnet', 'go', 'cargo', 'deno', 'bun']);

/** Words that can identify a launch: program names, scripts, ports. Lower case. */
export function tokens(command) {
  const words = String(command ?? '').toLowerCase().match(/[a-z0-9_.@:-]{2,}/g) ?? [];
  const out = new Set();
  for (const raw of words) {
    const word = raw.replace(/^[-:.]+|[-:.]+$/g, '').replace(/\.(cmd|exe|ps1)$/, '');
    if (word.length < 2 || COMMON.has(word) || COMMON.has(word.replace(/-/g, ''))) continue;
    if (/^\d+$/.test(word) && word.length < 4) continue; // "2", "12": noise; "3000", "5173": ports
    out.add(word);
  }
  return out;
}

function shareEnough(callTokens, commandLine) {
  const procTokens = tokens(commandLine);
  let shared = 0;
  let distinctive = false;
  for (const t of callTokens) {
    if (!procTokens.has(t)) continue;
    shared++;
    if (DISTINCTIVE.has(t) || /[./\\]/.test(t) || /^\d{4,5}$/.test(t)) distinctive = true;
  }
  return shared >= 2 && distinctive;
}

/**
 * @param {object} input
 * @param {{key: string, sessionId: string, at: number, cmd: string}[]} input.calls background-flagged calls
 * @param {{pid: number, ppid: number, startedAt: number, name: string, command: string}[]} input.processes
 * @param {Map<number, number[]>} input.ports pid -> listening ports
 * @param {Set<number>} input.ignore pids never reported (this monitor, OpenCode)
 * @returns {Map<string, object[]>} call key -> still-running process trees
 */
export function matchLeftovers({ calls, processes, ports, ignore = new Set() }) {
  const children = new Map();
  for (const p of processes) {
    if (!children.has(p.ppid)) children.set(p.ppid, []);
    children.get(p.ppid).push(p);
  }
  const claimed = new Set();
  const result = new Map();

  // Newest calls first, so a process is credited to the launch closest before it.
  for (const call of [...calls].sort((a, b) => b.at - a.at)) {
    const want = tokens(call.cmd);
    const roots = processes
      .filter(p => !claimed.has(p.pid) && !ignore.has(p.pid))
      .filter(p => p.startedAt >= call.at - EARLY_MS && p.startedAt <= call.at + START_WINDOW_MS)
      .filter(p => shareEnough(want, p.command));
    // Keep only the top of each matched tree.
    const rootPids = new Set(roots.map(p => p.pid));
    const tops = roots.filter(p => !rootPids.has(p.ppid));
    const found = [];
    for (const top of tops) {
      const tree = [];
      const walk = (p, depth) => {
        if (claimed.has(p.pid) || ignore.has(p.pid) || depth > 6) return;
        claimed.add(p.pid);
        tree.push(p);
        for (const child of children.get(p.pid) ?? []) if (child.startedAt >= top.startedAt - EARLY_MS) walk(child, depth + 1);
      };
      walk(top, 0);
      const treePorts = [...new Set(tree.flatMap(p => ports.get(p.pid) ?? []))].sort((a, b) => a - b);
      found.push({ pid: top.pid, name: top.name, command: top.command, startedAt: top.startedAt, processes: tree.length, pids: tree.map(p => p.pid), ports: treePorts });
    }
    if (found.length) result.set(call.key, found);
  }
  return result;
}

// --- reading the process table -------------------------------------------------------------

function run(cmd, args, timeout = 15_000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, timeout, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

const WIN_PROCESSES = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate,Name,CommandLine | ConvertTo-Json -Compress';

export function parseWindowsProcesses(json) {
  const list = JSON.parse(json || '[]');
  return (Array.isArray(list) ? list : [list]).map(p => ({
    pid: p.ProcessId,
    ppid: p.ParentProcessId,
    // Windows PowerShell 5.1 writes dates as "/Date(1700000000000)/".
    startedAt: Number(/\d{10,}/.exec(String(p.CreationDate ?? ''))?.[0] ?? NaN),
    name: String(p.Name ?? ''),
    command: String(p.CommandLine ?? ''),
  })).filter(p => Number.isFinite(p.startedAt));
}

/** `netstat -ano` (Windows) or `netstat -lntp`-style lines -> pid -> ports. */
export function parseNetstat(text) {
  const ports = new Map();
  for (const line of text.split('\n')) {
    const m = /^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i.exec(line);
    if (!m) continue;
    const [port, pid] = [Number(m[1]), Number(m[2])];
    if (!ports.has(pid)) ports.set(pid, []);
    if (!ports.get(pid).includes(port)) ports.get(pid).push(port);
  }
  return ports;
}

/** ps "etime": [[dd-]hh:]mm:ss -> seconds. */
export function parseEtime(text) {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(text.trim());
  if (!m) return NaN;
  return ((Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0)) * 60 + Number(m[3])) * 60 + Number(m[4]);
}

export function parsePs(text, now) {
  const out = [];
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    const seconds = m ? parseEtime(m[3]) : NaN;
    if (!m || Number.isNaN(seconds)) continue;
    const command = m[4].trim();
    out.push({ pid: Number(m[1]), ppid: Number(m[2]), startedAt: now - seconds * 1000, name: command.split(/\s+/)[0].split('/').pop(), command });
  }
  return out;
}

/** `lsof -nP -iTCP -sTCP:LISTEN -F pn` -> pid -> ports. */
export function parseLsof(text) {
  const ports = new Map();
  let pid = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pid != null) {
      const port = Number(/:(\d+)$/.exec(line)?.[1]);
      if (!port) continue;
      if (!ports.has(pid)) ports.set(pid, []);
      if (!ports.get(pid).includes(port)) ports.get(pid).push(port);
    }
  }
  return ports;
}

async function readProcessTable() {
  const now = Date.now();
  if (process.platform === 'win32') {
    const [procs, net] = await Promise.all([
      run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WIN_PROCESSES]),
      run('netstat', ['-ano', '-p', 'TCP']).catch(() => ''),
    ]);
    return { processes: parseWindowsProcesses(procs), ports: parseNetstat(net) };
  }
  const [procs, net] = await Promise.all([
    run('ps', ['-A', '-o', 'pid=,ppid=,etime=,args=']),
    run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pn']).catch(() => ''),
  ]);
  return { processes: parsePs(procs, now), ports: parseLsof(net) };
}

/**
 * Background probe. `refresh(calls)` re-reads the process table at most every `everyMs`,
 * and only when there are background calls to look for.
 */
export function createLeftoverProbe({ enabled = true, everyMs = 30_000, ignoreNames = [], read = readProcessTable } = {}) {
  let found = new Map();
  let last = 0;
  let busy = false;
  let failed = false;
  const ignoreRe = ignoreNames.length ? new RegExp(`(^|[\\\\/])(${ignoreNames.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(\\.exe)?$`, 'i') : null;

  async function refresh(calls) {
    if (!enabled || busy || Date.now() - last < everyMs) return;
    if (!calls.length) {
      found = new Map();
      return;
    }
    busy = true;
    try {
      const { processes, ports } = await read();
      const ignore = new Set([process.pid, process.ppid]);
      for (const p of processes) if (ignoreRe?.test(p.name)) ignore.add(p.pid);
      found = matchLeftovers({ calls, processes, ports, ignore });
      failed = false;
    } catch {
      failed = true; // Reported as "could not check", never as "nothing running".
    } finally {
      last = Date.now();
      busy = false;
    }
  }

  return { refresh, get: key => found.get(key) ?? [], failed: () => failed, enabled };
}
