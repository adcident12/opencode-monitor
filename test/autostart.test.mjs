import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { autostart, autostartCommand, launchdPlist, quoteArg, systemdUnit, TASK_NAME } from '../src/autostart.mjs';
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
  await assert.rejects(autostart('on', { root: '/srv/ocm', platform: 'sunos', run }), /does not know how/);
  await assert.rejects(autostart('maybe', { platform: 'win32', run }), /"on" or "off"/);
  assert.equal(calls.length, 2);
});

test('macOS: a launchd agent with each argument on its own, escaped for XML', () => {
  const unit = launchdPlist({ node: '/opt/node & co/bin/node', root: '/Users/ana/tools/opencode-monitor', args: { port: 4400, lang: 'th' }, home: '/Users/ana' });
  assert.equal(unit.path, join('/Users/ana', 'Library', 'LaunchAgents', 'com.opencode-monitor.plist'));
  assert.ok(unit.text.includes('<string>/opt/node &amp; co/bin/node</string>'));
  assert.ok(unit.text.includes(`<string>${join('/Users/ana/tools/opencode-monitor', 'server.mjs')}</string>`));
  assert.ok(unit.text.includes('<string>--port</string>\n    <string>4400</string>'));
  assert.ok(unit.text.includes('<key>RunAtLoad</key><true/>'));
  assert.throws(() => launchdPlist({ node: '/bin/node', root: '/x\ny', home: '/h' }), /Cannot start automatically/);
});

test('Linux: a systemd user unit whose command line a path cannot bend', () => {
  const unit = systemdUnit({ node: '/usr/bin/node', root: '/home/ana/my "tools"/100% $HOME', args: { noNotify: true }, home: '/home/ana' });
  assert.equal(unit.path, join('/home/ana', '.config', 'systemd', 'user', 'opencode-monitor.service'));
  const line = unit.text.split('\n').find(l => l.startsWith('ExecStart='));
  assert.ok(line.startsWith('ExecStart="/usr/bin/node" "'));
  // Quotes, percent signs and dollars in a path stay literal.
  assert.ok(line.includes(String.raw`my \"tools\"`), line);
  assert.ok(line.includes('100%% $$HOME'), line);
  assert.ok(line.endsWith(' "--no-notify"'));
  assert.ok(unit.text.includes('WantedBy=default.target'));
});

test('macOS and Linux: on writes the unit and tells the system; off undoes both', async () => {
  for (const [platform, tool] of [['darwin', '/bin/launchctl'], ['linux', 'systemctl']]) {
    const written = new Map();
    const calls = [];
    const files = { write: (path, text) => written.set(path, text), remove: path => written.delete(path), exists: path => written.has(path) };
    const exec = async (file, argv) => {
      calls.push([file, ...argv].join(' '));
    };
    const on = await autostart('on', { root: '/srv/ocm', args: { port: 4400 }, platform, home: '/home/ana', exec, files });
    assert.match(on, /will start each time you log in/);
    assert.equal(written.size, 1);
    assert.ok(calls.every(c => c.startsWith(tool)), calls.join(' | '));
    assert.ok(calls.some(c => /bootstrap|enable --now/.test(c)));

    assert.match(await autostart('off', { root: '/srv/ocm', platform, home: '/home/ana', exec, files }), /Removed/);
    assert.equal(written.size, 0);
    assert.match(await autostart('off', { root: '/srv/ocm', platform, home: '/home/ana', exec, files }), /nothing to remove/);
  }
});

test('--autostart takes on or off', () => {
  assert.deepEqual(parseArgs(['--autostart', 'on', '--port', '4400']), { autostart: 'on', port: 4400 });
  assert.throws(() => parseArgs(['--autostart']), /needs a value/);
});
