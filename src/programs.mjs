// Where the system programs the monitor runs live. Named in full where the system fixes the
// place, so that a program of the same name earlier in PATH is not run instead. On Linux the
// place differs between distributions, so ps, lsof, systemctl and notify-send are still found
// through PATH.
import { join } from 'node:path';

const system32 = (...parts) => join(process.env.SystemRoot ?? process.env.windir ?? String.raw`C:\Windows`, 'System32', ...parts);

/** Windows PowerShell 5.1, which ships with Windows. */
export const POWERSHELL = system32('WindowsPowerShell', 'v1.0', 'powershell.exe');
export const TASKLIST = system32('tasklist.exe');
export const NETSTAT = system32('netstat.exe');

// macOS: part of the system, always here.
export const OSASCRIPT = '/usr/bin/osascript';
export const LAUNCHCTL = '/bin/launchctl';
