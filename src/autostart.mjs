// Starts the monitor when you log in, so it is already watching when a prompt is left
// unanswered overnight. Each system's own mechanism, for the current user only, with no
// administrator rights, and removed again with --autostart off:
//   Windows  a scheduled task
//   macOS    a launchd agent in ~/Library/LaunchAgents
//   Linux    a systemd user unit in ~/.config/systemd/user
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { UserError } from './config.mjs';
import { LAUNCHCTL, POWERSHELL } from './programs.mjs';
import { trimEndOf } from './text.mjs';

export const TASK_NAME = 'opencode-monitor';

// Options that make sense for a background start; --sample or --test-notify do not.
const KEPT = ['port', 'dataDir', 'config', 'lang'];
const FLAG = { port: '--port', dataDir: '--data-dir', config: '--config', lang: '--lang' };

/** One argument of a Windows command line. A quote inside it cannot be carried safely. */
export function quoteArg(value) {
  const text = String(value);
  if (/["\r\n\0]/.test(text)) throw new UserError(`Cannot start automatically with this in a path or option: ${text}`);
  // A trailing backslash would escape the closing quote.
  const body = trimEndOf(text, '\\');
  return /[\s&|<>^%]/.test(text) || !text ? `"${body}${'\\'.repeat((text.length - body.length) * 2)}"` : text;
}

/**
 * What the task runs: node with server.mjs and the options given now, under conhost's
 * headless mode so no console window is left open on the desktop.
 * @returns {{execute: string, args: string, cwd: string}}
 */
export function autostartCommand({ node = process.execPath, root, args = {} }) {
  const parts = ['--headless', quoteArg(node), quoteArg(join(root, 'server.mjs'))];
  for (const key of KEPT) if (args[key] != null) parts.push(FLAG[key], quoteArg(args[key]));
  if (args.noNotify) parts.push('--no-notify');
  if (args.lan) parts.push('--lan');
  return { execute: 'conhost.exe', args: parts.join(' '), cwd: root };
}

// Values arrive through environment variables, so no path is ever parsed as script.
const INSTALL = `
$ErrorActionPreference = 'Stop'
$action = New-ScheduledTaskAction -Execute $env:OCM_EXECUTE -Argument $env:OCM_ARGS -WorkingDirectory $env:OCM_CWD
$trigger = New-ScheduledTaskTrigger -AtLogOn -User ([Security.Principal.WindowsIdentity]::GetCurrent().Name)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $env:OCM_TASK -Action $action -Trigger $trigger -Settings $settings -Description 'Local status page for OpenCode (opencode-monitor).' -Force | Out-Null
`;
const REMOVE = `
$ErrorActionPreference = 'Stop'
if (Get-ScheduledTask -TaskName $env:OCM_TASK -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $env:OCM_TASK -Confirm:$false; 'removed' } else { 'absent' }
`;

function powershell(script, env) {
  return new Promise((resolve, reject) => {
    execFile(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 30_000, env: { ...process.env, ...env } },
      (err, stdout, stderr) => (err ? reject(new UserError(`Windows refused: ${(stderr || err.message).trim().split('\n')[0]}`)) : resolve(stdout.trim())));
  });
}

/** The options to start the server with, as separate arguments. */
export function serverArgs(args = {}) {
  const out = [];
  for (const key of KEPT) if (args[key] != null) out.push(FLAG[key], String(args[key]));
  if (args.noNotify) out.push('--no-notify');
  if (args.lan) out.push('--lan');
  return out;
}

const LABEL = 'com.opencode-monitor';
const UNIT = 'opencode-monitor.service';
const xml = text => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
// A line break in a path would start a new line of the file it is written into.
const plain = value => {
  const text = String(value);
  if (/[\r\n\0]/.test(text)) throw new UserError(`Cannot start automatically with this in a path or option: ${text}`);
  return text;
};

/** macOS: a launchd agent that runs the server at login. */
export function launchdPlist({ node = process.execPath, root, args = {}, home = homedir() }) {
  const program = [node, join(root, 'server.mjs'), ...serverArgs(args)].map(plain);
  const log = join(home, 'Library', 'Logs', 'opencode-monitor.log');
  return {
    path: join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`),
    text: [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      '<dict>',
      `  <key>Label</key><string>${LABEL}</string>`,
      '  <key>ProgramArguments</key>',
      '  <array>',
      ...program.map(arg => `    <string>${xml(arg)}</string>`),
      '  </array>',
      `  <key>WorkingDirectory</key><string>${xml(plain(root))}</string>`,
      '  <key>RunAtLoad</key><true/>',
      `  <key>StandardOutPath</key><string>${xml(log)}</string>`,
      `  <key>StandardErrorPath</key><string>${xml(log)}</string>`,
      '</dict>',
      '</plist>',
      '',
    ].join('\n'),
  };
}

// One argument of a systemd command line: quoted, with what systemd would expand made literal.
const unitArg = value => `"${plain(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('$', '$$$$')}"`;

/** Linux: a systemd user unit that runs the server at login. */
export function systemdUnit({ node = process.execPath, root, args = {}, home = homedir() }) {
  return {
    path: join(home, '.config', 'systemd', 'user', UNIT),
    text: [
      '[Unit]',
      'Description=Local status page for OpenCode (opencode-monitor)',
      '',
      '[Service]',
      `ExecStart=${[node, join(root, 'server.mjs'), ...serverArgs(args)].map(unitArg).join(' ')}`,
      `WorkingDirectory=${plain(root)}`,
      'Restart=on-failure',
      'RestartSec=60',
      '',
      '[Install]',
      'WantedBy=default.target',
      '',
    ].join('\n'),
  };
}

function command(file, argv) {
  return new Promise((resolve, reject) => {
    execFile(file, argv, { timeout: 30_000 }, (err, stdout, stderr) => {
      if (err) reject(new UserError(`${file} ${argv.join(' ')}: ${(stderr || err.message).trim().split('\n')[0]}`));
      else resolve(stdout.trim());
    });
  });
}

// What the two file-based systems need: write a file, remove it, see whether it is there.
const FILES = {
  write: (path, text) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  },
  remove: path => rmSync(path, { force: true }),
  exists: existsSync,
};

async function autostartUnix(mode, { platform, root, args, home, exec, files }) {
  const mac = platform === 'darwin';
  const unit = (mac ? launchdPlist : systemdUnit)({ root, args, home });
  const domain = `gui/${process.getuid?.() ?? 0}`;
  if (mode === 'off') {
    const was = files.exists(unit.path);
    // Stopping fails when it was never loaded; removing the file is what matters.
    if (mac) await exec(LAUNCHCTL, ['bootout', `${domain}/${LABEL}`]).catch(() => {});
    else await exec('systemctl', ['--user', 'disable', '--now', UNIT]).catch(() => {});
    files.remove(unit.path);
    if (!mac) await exec('systemctl', ['--user', 'daemon-reload']).catch(() => {});
    return was ? `Removed ${unit.path}. The monitor will no longer start at login.` : `There was nothing to remove at ${unit.path}.`;
  }
  files.write(unit.path, unit.text);
  if (mac) {
    await exec(LAUNCHCTL, ['bootout', `${domain}/${LABEL}`]).catch(() => {}); // replace one already loaded
    await exec(LAUNCHCTL, ['bootstrap', domain, unit.path]);
  } else {
    await exec('systemctl', ['--user', 'daemon-reload']);
    await exec('systemctl', ['--user', 'enable', '--now', UNIT]);
  }
  return `The monitor will start each time you log in, and has been started now.\n  written: ${unit.path}\n  undo: node server.mjs --autostart off`;
}

/**
 * @param {'on'|'off'} mode
 * @returns {Promise<string>} a line to print
 */
export async function autostart(mode, { root, args = {}, platform = process.platform, run = powershell, home = homedir(), exec = command, files = FILES } = {}) {
  if (mode !== 'on' && mode !== 'off') throw new UserError('--autostart needs "on" or "off".');
  if (platform === 'darwin' || platform === 'linux') return autostartUnix(mode, { platform, root, args, home, exec, files });
  if (platform !== 'win32') throw new UserError(`--autostart does not know how to start a program at login on ${platform}.`);
  if (mode === 'off') {
    const outcome = await run(REMOVE, { OCM_TASK: TASK_NAME });
    return outcome === 'removed' ? `Removed the "${TASK_NAME}" task. A monitor that is running now keeps running until you stop it.` : `There was no "${TASK_NAME}" task to remove.`;
  }
  const command = autostartCommand({ root, args });
  await run(INSTALL, { OCM_TASK: TASK_NAME, OCM_EXECUTE: command.execute, OCM_ARGS: command.args, OCM_CWD: command.cwd });
  return `The monitor will start each time you log in (scheduled task "${TASK_NAME}").\n  runs: ${command.execute} ${command.args}\n  start it now: schtasks /Run /TN ${TASK_NAME}\n  undo: node server.mjs --autostart off`;
}
