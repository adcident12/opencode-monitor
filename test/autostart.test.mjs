import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { autostart, autostartCommand, quoteArg, TASK_NAME } from '../src/autostart.mjs';
import { parseArgs } from '../src/config.mjs';

test('the command the task runs: node hidden, with the options that suit a background start', () => {
  const root = join('E:', 'my tools', 'opencode-monitor');
  const command = autostartCommand({ node: 'C:\\Program Files\\nodejs\\node.exe', root, args: { port: 4400, lang: 'th', sample: true, testNotify: true, noNotify: true } });
  assert.equal(command.execute, 'conhost.exe');
  assert.equal(command.cwd, root);
  assert.equal(command.args, `--headless "C:\\Program Files\\nodejs\\node.exe" "${join(root, 'server.mjs')}" --port 4400 --lang th --no-notify`);
});

test('arguments are quoted only when needed, and a quote inside one is refused', () => {
  assert.equal(quoteArg('C:\\nvm4w\\nodejs\\node.exe'), 'C:\\nvm4w\\nodejs\\node.exe');
  assert.equal(quoteArg('D:\\data dir\\'), '"D:\\data dir\\\\"');
  assert.equal(quoteArg('a&b'), '"a&b"');
  assert.throws(() => quoteArg('x" & calc & "'), /Cannot start automatically/);
});

test('on and off go to Windows with values in the environment, never in the script', async () => {
  const calls = [];
  const run = async (script, env) => {
    calls.push({ script, env });
    return 'removed';
  };
  const on = await autostart('on', { root: 'E:\\opencode-monitor', args: { port: 4317 }, platform: 'win32', run });
  assert.match(on, /will start each time you log in/);
  assert.deepEqual(Object.keys(calls[0].env).sort(), ['OCM_ARGS', 'OCM_CWD', 'OCM_EXECUTE', 'OCM_TASK']);
  assert.equal(calls[0].env.OCM_TASK, TASK_NAME);
  assert.ok(!calls[0].script.includes('E:\\opencode-monitor'), 'no path is written into the script');

  assert.match(await autostart('off', { platform: 'win32', run }), /Removed/);
  assert.match(await autostart('off', { platform: 'win32', run: async () => 'absent' }), /no "opencode-monitor" task/);
  await assert.rejects(autostart('on', { root: '/srv/ocm', platform: 'linux', run }), /only implemented for Windows/);
  await assert.rejects(autostart('maybe', { platform: 'win32', run }), /"on" or "off"/);
  assert.equal(calls.length, 2);
});

test('--autostart takes on or off', () => {
  assert.deepEqual(parseArgs(['--autostart', 'on', '--port', '4400']), { autostart: 'on', port: 4400 });
  assert.throws(() => parseArgs(['--autostart']), /needs a value/);
});
