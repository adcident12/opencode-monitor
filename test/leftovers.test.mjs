import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLeftoverProbe, matchLeftovers, parseEtime, parseLsof, parseNetstat, parsePs, parseWindowsProcesses, tokens } from '../src/leftovers.mjs';

const T = 1_800_000_000_000;
const proc = (pid, ppid, startedAt, name, command) => ({ pid, ppid, startedAt, name, command });

const devServer = 'cd D:\\medq-app; Start-Process -FilePath "cmd" -ArgumentList "/c","npx","next","dev","-p","3000" -WindowStyle Hidden';

test('tokens keep what identifies a launch and drop shell boilerplate', () => {
  const words = tokens(devServer);
  for (const word of ['npx', 'next', '3000', 'medq-app']) assert.ok(words.has(word), word);
  for (const noise of ['start-process', 'filepath', 'cmd', 'dev', 'hidden', 'p']) assert.ok(!words.has(noise), noise);
});

test('a dev server tree started right after the call is found, with the port its child holds', () => {
  const found = matchLeftovers({
    calls: [{ key: 'c1', at: T, cmd: devServer }],
    processes: [
      proc(100, 1, T + 600, 'cmd.exe', 'cmd /c npx next dev -p 3000'),
      proc(101, 100, T + 900, 'node.exe', 'node C:\\Users\\me\\npm-cache\\npx\\next\\dist\\bin\\next dev -p 3000'),
      proc(102, 101, T + 2000, 'node.exe', 'node .next\\server.js'),
      // Same moment, unrelated program: not taken.
      proc(200, 1, T + 700, 'node.exe', 'node C:\\tools\\other-thing\\index.js --watch'),
      // Same words, but started an hour before the call: not this launch.
      proc(300, 1, T - 3_600_000, 'cmd.exe', 'cmd /c npx next dev -p 3000'),
    ],
    ports: new Map([[102, [3000]], [200, [9229]]]),
  });
  const [tree] = found.get('c1');
  assert.deepEqual([tree.pid, tree.processes, tree.pids, tree.ports], [100, 3, [100, 101, 102], [3000]]);
  assert.equal(found.get('c1').length, 1);
});

test('nothing is reported when nothing matches, and ignored pids are never reported', () => {
  const processes = [proc(100, 1, T + 500, 'opencode.exe', 'opencode npx next dev 3000')];
  assert.equal(matchLeftovers({ calls: [{ key: 'c1', at: T, cmd: devServer }], processes, ports: new Map(), ignore: new Set([100]) }).size, 0);
  assert.equal(matchLeftovers({ calls: [{ key: 'c1', at: T, cmd: 'nohup python worker.py &' }], processes: [proc(5, 1, T + 100, 'node', 'node server.js')], ports: new Map() }).size, 0);
});

test('a process is credited to the launch closest before it', () => {
  const found = matchLeftovers({
    calls: [{ key: 'old', at: T, cmd: devServer }, { key: 'new', at: T + 20_000, cmd: devServer }],
    processes: [proc(100, 1, T + 21_000, 'cmd.exe', 'cmd /c npx next dev -p 3000')],
    ports: new Map(),
  });
  assert.deepEqual([found.has('old'), found.get('new')[0].pid], [false, 100]);
});

test('process table parsers', () => {
  const win = parseWindowsProcesses(JSON.stringify([
    { ProcessId: 10, ParentProcessId: 1, CreationDate: '/Date(1800000000123)/', Name: 'node.exe', CommandLine: 'node a.js' },
    { ProcessId: 0, ParentProcessId: 0, CreationDate: null, Name: 'System Idle Process', CommandLine: null },
  ]));
  assert.deepEqual(win, [{ pid: 10, ppid: 1, startedAt: 1_800_000_000_123, name: 'node.exe', command: 'node a.js' }]);

  const net = parseNetstat('  TCP    0.0.0.0:3000     0.0.0.0:0      LISTENING       11572\n  TCP    [::]:3000   [::]:0   LISTENING   11572\n  TCP    127.0.0.1:5000   1.2.3.4:443   ESTABLISHED   7\n');
  assert.deepEqual([...net], [[11572, [3000]]]);

  assert.equal(parseEtime('05:07'), 307);
  assert.equal(parseEtime('2:05:07'), 7507);
  assert.equal(parseEtime('1-02:05:07'), 93_907);
  assert.deepEqual(parsePs('  42     1      01:40 /usr/bin/node /srv/app/server.js --port 3000\n garbage\n', T), [
    { pid: 42, ppid: 1, startedAt: T - 100_000, name: 'node', command: '/usr/bin/node /srv/app/server.js --port 3000' },
  ]);
  assert.deepEqual([...parseLsof('p42\nf20\nn*:3000\np77\nf9\nn127.0.0.1:5432\n')], [[42, [3000]], [77, [5432]]]);
});

test('probe: a failed process listing is reported as such, not as "nothing running"', async () => {
  const probe = createLeftoverProbe({ everyMs: 0, read: async () => { throw new Error('denied'); } });
  await probe.refresh([{ key: 'c1', at: T, cmd: devServer }]);
  assert.equal(probe.failed(), true);
  assert.deepEqual(probe.get('c1'), []);

  const ok = createLeftoverProbe({ everyMs: 0, read: async () => ({ processes: [proc(100, 1, T + 600, 'cmd.exe', 'cmd /c npx next dev -p 3000')], ports: new Map() }) });
  await ok.refresh([{ key: 'c1', at: T, cmd: devServer }]);
  assert.deepEqual([ok.failed(), ok.get('c1')[0].pid], [false, 100]);
});
