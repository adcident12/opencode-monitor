// The MCP tools over HTTP, for an assistant on another machine: one JSON-RPC message per POST.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { answerMcp } from '../src/mcp-http.mjs';
import { createMcpServer } from '../src/mcp-server.mjs';

async function withServer(run) {
  const handle = createMcpServer({ tools: [{ name: 'opencode_hello', description: 'Says hello.', inputSchema: { type: 'object' }, run: () => ({ hello: true }) }], version: '1' });
  const server = createServer((req, res) => answerMcp(req, res, handle, new Set(['http://127.0.0.1:4317'])));
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  try {
    await run(url);
  } finally {
    server.closeAllConnections();
    await new Promise(done => server.close(done));
  }
}
const post = (url, body, headers = {}) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

test('a request is answered with JSON; a notification with 202 and nothing', async () => {
  await withServer(async url => {
    const init = await post(url, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    assert.equal(init.status, 200);
    assert.match(init.headers.get('content-type'), /application\/json/);
    assert.equal((await init.json()).result.serverInfo.name, 'opencode-monitor');
    const note = await post(url, { jsonrpc: '2.0', method: 'notifications/initialized' });
    assert.equal(note.status, 202);
    const call = await (await post(url, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'opencode_hello', arguments: {} } })).json();
    assert.deepEqual(JSON.parse(call.result.content[0].text), { hello: true });
    // A batch gets a batch.
    const both = await (await post(url, [{ jsonrpc: '2.0', id: 3, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/x' }])).json();
    assert.deepEqual(both, [{ jsonrpc: '2.0', id: 3, result: {} }]);
  });
});

test('no stream to open, nothing but JSON, nothing too large, and no web page from elsewhere', async () => {
  await withServer(async url => {
    assert.equal((await fetch(url)).status, 405);
    assert.equal((await post(url, '{broken')).status, 400);
    assert.equal((await post(url, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', pad: 'x'.repeat(1_100_000) }))).status, 413);
    assert.equal((await post(url, { jsonrpc: '2.0', id: 1, method: 'ping' }, { origin: 'http://evil.example' })).status, 403);
    assert.equal((await post(url, { jsonrpc: '2.0', id: 1, method: 'ping' }, { origin: 'http://127.0.0.1:4317' })).status, 200);
  });
});
