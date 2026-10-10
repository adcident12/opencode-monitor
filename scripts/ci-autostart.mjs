// Real check of --autostart, run by CI on each system: install it, wait for the monitor it
// started to answer, remove it, and see that it is gone. The unit tests only check the text
// of what is written; this checks that the system accepts it and runs it.
//
// It registers a login item for the current user and removes it again. Meant for a CI
// runner; on your own machine it would replace an autostart you already have.
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSample } from './make-sample.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4399;
const URL_STATE = `http://127.0.0.1:${PORT}/api/state`;
const sleep = ms => new Promise(done => setTimeout(done, ms));

const run = (file, args, options = {}) =>
  new Promise(done => execFile(file, args, { cwd: ROOT, timeout: 60_000, ...options }, (err, stdout, stderr) => done({ ok: !err, out: `${stdout}${stderr}`.trim() })));
const server = (...args) => run(process.execPath, ['server.mjs', ...args]);

async function answers() {
  try {
    const res = await fetch(URL_STATE, { signal: AbortSignal.timeout(3000) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

async function waitFor(check, seconds) {
  for (let i = 0; i < seconds; i++) {
    const value = await check();
    if (value) return value;
    await sleep(1000);
  }
  return null;
}

// What the system itself says, printed when something fails.
async function diagnose() {
  const say = async (title, file, args) => console.log(`--- ${title}\n${(await run(file, args)).out}`);
  if (process.platform === 'linux') {
    await say('systemctl status', 'systemctl', ['--user', 'status', 'opencode-monitor.service', '--no-pager']);
    await say('journal', 'journalctl', ['--user', '-u', 'opencode-monitor.service', '--no-pager', '-n', '40']);
  } else if (process.platform === 'darwin') {
    await say('launchctl print', 'launchctl', ['print', `gui/${process.getuid()}/com.opencode-monitor`]);
    const log = join(homedir(), 'Library', 'Logs', 'opencode-monitor.log');
    console.log(`--- ${log}\n${existsSync(log) ? readFileSync(log, 'utf8') : '(no log)'}`);
  } else {
    await say('task', 'schtasks', ['/Query', '/TN', 'opencode-monitor', '/V', '/FO', 'LIST']);
  }
}

const sample = buildSample(join(ROOT, 'sample'));
let failed = false;
const fail = message => {
  failed = true;
  console.error(`FAIL: ${message}`);
};

console.log(`autostart check on ${process.platform}`);
const on = await server('--autostart', 'on', '--data-dir', sample, '--port', String(PORT), '--no-notify');
console.log(on.out);
if (!on.ok) fail('--autostart on did not succeed');

if (on.ok) {
  // Windows registers the task for the next login; the others start it at once.
  if (process.platform === 'win32') console.log((await run('schtasks', ['/Run', '/TN', 'opencode-monitor'])).out);
  const state = await waitFor(answers, 60);
  if (!state) fail('the monitor it started never answered');
  else if (state.sessions?.length !== 10) fail(`expected the 10 sample sessions, got ${state.sessions?.length}`);
  else console.log(`ok: the monitor answers on ${PORT} with ${state.sessions.length} sessions, version ${state.version}`);
}
if (failed) await diagnose();

const off = await server('--autostart', 'off');
console.log(off.out);
if (!off.ok) fail('--autostart off did not succeed');

if (process.platform === 'win32') {
  // Removing the task does not stop what it started; do that here.
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-Command', `Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }`]);
  } catch {
    // Nothing was listening.
  }
} else if (!(await waitFor(async () => !(await answers()), 30))) {
  fail('the monitor was still answering after --autostart off');
  await diagnose();
}

const again = await server('--autostart', 'off');
if (!/nothing to remove|no "opencode-monitor" task/.test(again.out)) fail(`a second off should find nothing: ${again.out}`);

console.log(failed ? 'autostart check FAILED' : 'autostart check passed');
process.exit(failed ? 1 : 0);
