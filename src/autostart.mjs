// Starts the monitor when you log in, so it is already watching when a prompt is left
// unanswered overnight. Windows only for now: a scheduled task for the current user, which
// needs no administrator rights and is removed again with --autostart off.
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { UserError } from './config.mjs';

export const TASK_NAME = 'opencode-monitor';

// Options that make sense for a background start; --sample or --test-notify do not.
const KEPT = ['port', 'dataDir', 'config', 'lang'];
const FLAG = { port: '--port', dataDir: '--data-dir', config: '--config', lang: '--lang' };

/** One argument of a Windows command line. A quote inside it cannot be carried safely. */
export function quoteArg(value) {
  const text = String(value);
  if (/["\r\n\0]/.test(text)) throw new UserError(`Cannot start automatically with this in a path or option: ${text}`);
  // A trailing backslash would escape the closing quote.
  return /[\s&|<>^%]/.test(text) || !text ? `"${text.replace(/\\+$/, m => m + m)}"` : text;
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
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 30_000, env: { ...process.env, ...env } },
      (err, stdout, stderr) => (err ? reject(new UserError(`Windows refused: ${(stderr || err.message).trim().split('\n')[0]}`)) : resolve(stdout.trim())));
  });
}

/**
 * @param {'on'|'off'} mode
 * @returns {Promise<string>} a line to print
 */
export async function autostart(mode, { root, args = {}, platform = process.platform, run = powershell } = {}) {
  if (mode !== 'on' && mode !== 'off') throw new UserError('--autostart needs "on" or "off".');
  if (platform !== 'win32') {
    throw new UserError('--autostart is only implemented for Windows. On macOS or Linux, add "node server.mjs" to launchd or a systemd user unit.');
  }
  if (mode === 'off') {
    const outcome = await run(REMOVE, { OCM_TASK: TASK_NAME });
    return outcome === 'removed' ? `Removed the "${TASK_NAME}" task. A monitor that is running now keeps running until you stop it.` : `There was no "${TASK_NAME}" task to remove.`;
  }
  const command = autostartCommand({ root, args });
  await run(INSTALL, { OCM_TASK: TASK_NAME, OCM_EXECUTE: command.execute, OCM_ARGS: command.args, OCM_CWD: command.cwd });
  return `The monitor will start each time you log in (scheduled task "${TASK_NAME}").\n  runs: ${command.execute} ${command.args}\n  start it now: schtasks /Run /TN ${TASK_NAME}\n  undo: node server.mjs --autostart off`;
}
