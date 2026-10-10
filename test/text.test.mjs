import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fields, trimEndOf, trimStartOf } from '../src/text.mjs';
import { classifyPart } from '../src/audit.mjs';
import { quoteArg } from '../src/autostart.mjs';
import { matchProcesses } from '../src/process.mjs';
import { parsePs } from '../src/leftovers.mjs';

test('trimming a run of characters from either end', () => {
  assert.equal(trimEndOf('http://x/v1///', '/'), 'http://x/v1');
  assert.equal(trimEndOf('///', '/'), '');
  assert.equal(trimEndOf('', '/'), '');
  assert.equal(trimStartOf('--.:name.', '-:.'), 'name.');
  assert.equal(trimEndOf(trimStartOf('-.-', '-:.'), '-:.'), '');
});

test('the first fields of a line, and the rest', () => {
  assert.deepEqual(fields('  12   34 05:10  node  server.mjs --port 1 \r', 3), ['12', '34', '05:10', 'node  server.mjs --port 1']);
  assert.deepEqual(fields('7 bash', 1), ['7', 'bash']);
  assert.deepEqual(fields('7', 1), ['7', '']);
  assert.equal(fields('7', 2), null);
  assert.equal(fields('   ', 1), null);
});

test('process lists are read as before', () => {
  assert.equal(matchProcesses('  10 /usr/local/bin/opencode\n', ['opencode'], 'linux', 1), true);
  assert.equal(matchProcesses('  x10 /usr/local/bin/opencode\n', ['opencode'], 'linux', 1), false);
  assert.equal(matchProcesses('  10 /usr/local/bin/opencode\n', ['opencode'], 'linux', 10), false, 'our own process');
  const [p] = parsePs('  412     1    01:05 /usr/bin/node  /srv/app/server.js --port 3000  \n garbage line\n 5 6 notatime x\n', 1_000_000);
  assert.deepEqual(p, { pid: 412, ppid: 1, startedAt: 1_000_000 - 65_000, name: 'node', command: '/usr/bin/node  /srv/app/server.js --port 3000' });
});

test('a Windows argument ending in backslashes keeps its closing quote', () => {
  assert.equal(quoteArg('C:\\my data\\'), '"C:\\my data\\\\"');
  assert.equal(quoteArg('C:\\my data\\\\'), '"C:\\my data\\\\\\\\"');
  assert.equal(quoteArg('C:\\data\\'), 'C:\\data\\');
  assert.equal(quoteArg(''), '""');
});

test('a variable in command position is still noticed, and a huge blank command is read quickly', () => {
  const rules = cmd => classifyPart({ tool: 'bash', cmd }).map(f => f.rule);
  for (const cmd of ['$RM -rf x', 'cd /tmp; $TOOL --go', 'true &&   ${X} y', 'a |\t$B c', 'echo hi\n  $CMD ./run', 'echo hi\r\n$CMD ./run']) {
    assert.ok(rules(cmd).includes('hidden_command'), cmd);
  }
  assert.ok(!rules('echo $HOME/x').includes('hidden_command'));
  // Lines that read a long run of blank text once, not once per character of it.
  const started = performance.now();
  rules(`echo a${'\n'.repeat(200_000)}echo b`);
  rules(`a${'.'.repeat(200_000)}b ${'-'.repeat(200_000)}`);
  rules(`echo a${'\r'.repeat(200_000)}echo b`);
  rules(`echo a;${' '.repeat(200_000)}echo b`);
  matchProcesses(`${' '.repeat(200_000)}\r\n`, ['opencode'], 'linux', 1);
  quoteArg(`${'\\'.repeat(200_000)}x y`);
  assert.ok(performance.now() - started < 2000, `took ${Math.round(performance.now() - started)} ms`);
});
