// OpenCode Central: behind a reverse proxy that does its own login, the hub trusts requests that carry the proxy's
// secret header instead of asking its own access key. Anything else still goes through the normal gate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { admitVia } from '../src/central/proxy.mjs';

const SECRET = 'a'.repeat(40);
const proxy = { header: 'x-ocm-proxy', secret: SECRET };
function fakeRes() {
  const r = { status: null, ended: false, writeHead(s) { r.status = s; return r; }, end() { r.ended = true; return r; } };
  return r;
}
const req = (headers = {}, url = '/api/machines', method = 'GET') => ({ url, method, headers: { host: 'opcm.example.org', ...headers } });
const access = { hosts: new Set(['opcm.example.org']) };
const normal = (calls) => (rq, rs) => { calls.push(rq.url); rs.writeHead(401).end(); return null; };

test('the right secret header: admitted without the access key', () => {
  const calls = [];
  const res = fakeRes();
  const out = admitVia(req({ 'x-ocm-proxy': SECRET }), res, access, proxy, normal(calls));
  assert.equal(out.url.pathname, '/api/machines');
  assert.equal(out.toMcp, false);
  assert.deepEqual(calls, [], 'the normal gate is not asked');
  assert.equal(res.status, null);
});

test('a wrong or missing header goes through the normal gate (the access key)', () => {
  for (const h of [{}, { 'x-ocm-proxy': 'nope' }, { 'x-ocm-proxy': `${SECRET}x` }]) {
    const calls = [];
    const res = fakeRes();
    assert.equal(admitVia(req(h), res, access, proxy, normal(calls)), null);
    assert.equal(calls.length, 1);
    assert.equal(res.status, 401);
  }
});

test('the header under a name the hub does not answer to: 403', () => {
  const res = fakeRes();
  assert.equal(admitVia({ ...req({ 'x-ocm-proxy': SECRET }), headers: { host: 'evil.example', 'x-ocm-proxy': SECRET } }, res, access, proxy, normal([])), null);
  assert.equal(res.status, 403);
});

test('only GET (and /mcp) pass, as through the normal gate', () => {
  const res = fakeRes();
  assert.equal(admitVia(req({ 'x-ocm-proxy': SECRET }, '/api/machines', 'POST'), res, access, proxy, normal([])), null);
  assert.equal(res.status, 403);
});

test('no proxy configured, or a short secret: the header means nothing', () => {
  for (const p of [null, { header: 'x-ocm-proxy', secret: 'short' }]) {
    const calls = [];
    admitVia(req({ 'x-ocm-proxy': p?.secret ?? SECRET }), fakeRes(), access, p, normal(calls));
    assert.equal(calls.length, 1);
  }
});
