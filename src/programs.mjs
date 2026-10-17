// Where the system programs the monitor runs live, named in full, so that a program of the
// same name earlier in PATH is never run instead. On Linux the place differs between
// distributions, so each is looked for in the system's own folders, which only an
// administrator can write to; PATH is not used.
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const system32 = (...parts) => join(process.env.SystemRoot ?? process.env.windir ?? String.raw`C:\Windows`, 'System32', ...parts);

/** Windows PowerShell 5.1, which ships with Windows. */
export const POWERSHELL = system32('WindowsPowerShell', 'v1.0', 'powershell.exe');
export const TASKLIST = system32('tasklist.exe');
export const NETSTAT = system32('netstat.exe');

// macOS: part of the system, always here.
export const OSASCRIPT = '/usr/bin/osascript';
export const LAUNCHCTL = '/bin/launchctl';

// Linux: the system's folders, the usual first; NixOS keeps its programs in the last.
const LINUX_DIRS = ['/usr/bin', '/bin', '/usr/sbin', '/sbin', '/run/current-system/sw/bin'];

/**
 * A Linux program by its full path: the first system folder that has it. When none does, the
 * first folder's path, which fails to start as "not found" rather than run one from PATH.
 */
export function linuxProgram(name, exists = existsSync) {
  const dir = LINUX_DIRS.find(d => exists(join(d, name))) ?? LINUX_DIRS[0];
  return `${dir}/${name}`;
}

const linux = process.platform === 'linux';
export const PS = linux ? linuxProgram('ps') : '/bin/ps';
export const LSOF = linux ? linuxProgram('lsof') : '/usr/sbin/lsof';
export const SYSTEMCTL = linuxProgram('systemctl');
export const NOTIFY_SEND = linuxProgram('notify-send');
