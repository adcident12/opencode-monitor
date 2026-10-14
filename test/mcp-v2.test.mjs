// OpenCode 2's MCP connections: a server that failed in a folder, and was not connected again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogTail, parseMcpConnectLine } from '../src/logtail.mjs';
import { buildTools } from '../src/mcp-server.mjs';

const FAILED = 'timestamp=2026-10-14T03:06:20.456Z level=WARN run=svc message="mcp connect failed" server=context7 status.status=failed status.error="Request timed out" http.span=91633 role=server server=context7 directory="E:\\\\queue-appointment-management" connectionID=364c';
const CONNECTED = 'timestamp=2026-10-14T03:17:57.858Z level=INFO run=svc message="mcp connected" server=context7 tools=2 http.span=763 role=server server=context7 directory="E:\\\\queue-appointment-management" connectionID=2e2d';
const OTHER = 'timestamp=2026-10-14T03:07:50.460Z level=WARN run=svc message="mcp connect failed" server=context7 status.status=failed status.error="Request timed out" role=server server=context7 directory="C:\\\\Users\\\\me" connectionID=0f60';

test('a connection line says which server, which folder, and how it went', () => {
  assert.deepEqual(parseMcpConnectLine(FAILED), { t: Date.parse('2026-10-14T03:06:20.456Z'), run: 'svc', name: 'context7', directory: 'E:\\queue-appointment-management', ok: false, error: 'Request timed out' });
  assert.equal(parseMcpConnectLine(CONNECTED).ok, true);
  assert.equal(parseMcpConnectLine(FAILED.replace('mcp connect failed', 'mcp transport error')), null);
});

test('down in a folder until connected there again; the settings tool gives the command', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ocm-mcp2-'));
  const file = join(dir, 'opencode.log');
  try {
    // The service run starts and keeps writing, so it is live.
    appendFileSync(file, 'timestamp=2026-10-14T03:00:00.000Z level=INFO run=svc message="cli starting" version=2.0.28\n');
    appendFileSync(file, 'timestamp=2026-10-14T03:00:01.000Z level=INFO run=svc message="creating instance"\n');
    appendFileSync(file, `${FAILED}\n${OTHER}\n`);
    const log = createLogTail(file);
    log.poll();
    assert.deepEqual(log.mcpDisconnected().map(c => c.directory).sort(), ['C:\\Users\\me', 'E:\\queue-appointment-management']);
    assert.equal(log.mcpFailures().get('context7').kind, 'unavailable');

    appendFileSync(file, `${CONNECTED}\n`);
    log.poll();
    assert.deepEqual(log.mcpDisconnected().map(c => c.directory), ['C:\\Users\\me']);

    const tools = buildTools({
      stats: () => ({ speed: { models: [] } }), cfg: { opencodeConfigDir: dir, dataDir: dir }, t: k => k, configChanges: { list: () => [] }, redact: x => x,
      opencode: { mcp: [{ name: 'context7', type: 'remote', enabled: true }], limits: new Map(), reserves: new Map(), compaction: {} },
      mcpDisconnected: () => log.mcpDisconnected(),
    });
    const settings = tools.find(x => x.name === 'opencode_settings').run({});
    assert.deepEqual(settings.mcpServers[0].disconnected.map(d => d.reconnect), ['opencode api experimental.mcp.connect --param server=context7 --param "location[directory]=C:\\Users\\me"']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
