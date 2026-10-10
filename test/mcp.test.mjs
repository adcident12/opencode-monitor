import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeMcpStats, createServerMatcher, faultOf, latestFailures, markShutdowns, mergeServers } from '../src/mcp.mjs';
import { createProjectMcp } from '../src/opencode-config.mjs';
import { mcpStatus } from '../src/environment.mjs';

const T = 1_800_000_000_000;

test('a tool is attributed to the longest server name that fits, as OpenCode spells it', () => {
  const match = createServerMatcher(['chrome', 'chrome-devtools', 'my server.v2']);
  assert.deepEqual(match('chrome-devtools_click'), { server: 'chrome-devtools', tool: 'click' });
  assert.deepEqual(match('chrome_open'), { server: 'chrome', tool: 'open' });
  assert.deepEqual(match('my_server_v2_run'), { server: 'my server.v2', tool: 'run' });
  assert.equal(match('bash'), null);
});

test('only transport errors count as the server being at fault', () => {
  assert.equal(faultOf('MCP error -32000: Connection closed'), 'connection');
  assert.equal(faultOf('Not connected'), 'connection');
  assert.equal(faultOf('MCP error -32001: Request timed out'), 'timeout');
  // The tool ran and reported its own failure.
  assert.equal(faultOf("Error: Unexpected token ';'"), null);
  assert.equal(faultOf('Error: Timed out after waiting 5000ms'), null);
  assert.equal(faultOf(null), null);
});

test('closing connections because OpenCode quit is not a server failing', () => {
  const close = (run, name, t) => ({ t, run, kind: 'closed', name });
  const events = [
    close('old', 'graft', T), // last line of a finished run
    close('now', 'memory', T + 60_000), // alone, and the run went on
    close('now', 'graft', T + 90_000), // three at once: a shutdown
    close('now', 'chrome-devtools', T + 90_400),
    close('now', 'context7', T + 91_000),
    { t: T + 50_000, run: 'now', kind: 'unavailable', name: 'sonarqube' },
  ];
  const marked = markShutdowns(events, new Map([['old', T + 500], ['now', T + 91_000]]), 'now');
  assert.deepEqual(marked.map(e => e.shutdown), [true, false, true, true, true, false]);
  assert.deepEqual([...latestFailures(marked).keys()].sort(), ['memory', 'sonarqube']);
});

test('a project config adds servers and can switch a globally disabled one on', () => {
  const merged = mergeServers(
    [{ name: 'graft', type: 'local', enabled: true }, { name: 'open-design', type: 'local', enabled: false }],
    [{ name: 'open-design', type: null, enabled: true }, { name: 'godot', type: 'local', enabled: true }],
  );
  assert.deepEqual(merged.map(s => [s.name, s.enabled, s.scope]), [['graft', true, 'global'], ['open-design', true, 'global'], ['godot', true, 'project']]);
});

test('project configs are read for MCP names only, and not from a network path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ocm-mcp-'));
  writeFileSync(join(dir, 'opencode.json'), '{ "mcp": { "godot": { "type": "local", "command": ["godot-mcp"], "environment": { "TOKEN": "secret" } } } }');
  mkdirSync(join(dir, '.opencode'));
  writeFileSync(join(dir, '.opencode', 'opencode.jsonc'), '{ /* per project */ "mcp": { "open-design": { "enabled": true }, "off": { "enabled": false } } }');
  const project = createProjectMcp();
  assert.deepEqual(project.forDirs([dir, '\\\\server\\share\\repo', join(dir, 'missing')]), [
    { name: 'godot', type: 'local', enabled: true },
    { name: 'open-design', type: null, enabled: true },
    { name: 'off', type: null, enabled: false },
  ]);
});

test('per server: calls, the two kinds of failure, time, disconnects, and what is never used', () => {
  const call = (tool, extra = {}) => ({ tool, status: 'completed', error: null, session_id: 's1', at: T, runMs: 100, ...extra });
  const rows = computeMcpStats({
    servers: mergeServers([
      { name: 'chrome-devtools', type: 'local', enabled: true },
      { name: 'memory', type: 'local', enabled: true },
      { name: 'github', type: 'remote', enabled: false },
    ]),
    calls: [
      call('chrome-devtools_evaluate_script'),
      call('chrome-devtools_evaluate_script', { status: 'error', error: "Error: Unexpected token ';'", runMs: 300, at: T + 5000, session_id: 's2' }),
      call('chrome-devtools_click', { status: 'error', error: 'MCP error -32001: Request timed out', runMs: null }),
      call('bash'),
    ],
    events: [
      { t: T, run: 'r', kind: 'closed', name: 'chrome-devtools', shutdown: false },
      { t: T, run: 'r', kind: 'closed', name: 'chrome-devtools', shutdown: true },
      { t: T - 10, run: 'r', kind: 'unavailable', name: 'memory', shutdown: false }, // before the period
    ],
    from: T,
    now: T + 10_000,
  });
  const [chrome, memory, github] = rows;
  assert.deepEqual(
    [chrome.name, chrome.calls, chrome.errors, chrome.faults, chrome.avgMs, chrome.sessions, chrome.lastUsedAt, chrome.disconnects, chrome.unused],
    ['chrome-devtools', 3, 1, 1, 200, 2, T + 5000, 1, false],
  );
  assert.deepEqual(chrome.tools, [{ tool: 'evaluate_script', count: 2, errors: 1, faults: 0 }, { tool: 'click', count: 1, errors: 0, faults: 1 }]);
  assert.deepEqual([memory.name, memory.calls, memory.unused, memory.startFailures], ['memory', 0, true, 0]);
  assert.deepEqual([github.name, github.enabled, github.unused], ['github', false, false]);
});

test('one session: disconnects are not claimed, because the log does not name a session', () => {
  const [row] = computeMcpStats({ servers: mergeServers([{ name: 'graft', type: 'local', enabled: true }]), calls: [], events: null, from: T, now: T + 1 });
  assert.deepEqual([row.disconnects, row.startFailures], [null, null]);
});

test('a tool call that could not reach its server marks it failed until one works again', () => {
  const status = use => mcpStatus({
    servers: mergeServers([{ name: 'graft', type: 'local', enabled: true }]),
    failures: new Map(), lastRun: 'r', opencodeRunning: true, use: new Map([['graft', use]]),
  })[0];
  assert.deepEqual([status({ okAt: T, connErrAt: T + 1 }).status, status({ okAt: T, connErrAt: T + 1 }).kind], ['failed', 'closed']);
  assert.equal(status({ okAt: T + 2, connErrAt: T + 1 }).status, 'ok');
  assert.equal(status({ okAt: null, connErrAt: null }).status, 'unknown');
});
