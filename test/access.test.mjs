import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { askPage, createAccess, isLoopback, lanAddresses, loadAccessKey } from '../src/access.mjs';

const KEY = 'k'.repeat(32);
const from = (remoteAddress, headers = {}) => ({ socket: { remoteAddress }, headers });
const at = path => new URL(path, 'http://x');
const lan = () => createAccess({ lan: true, port: 4317, key: KEY, addresses: ['192.168.1.5'], name: 'Desk' });

test('access: without --lan the monitor answers to its two local names only, and asks no one for a key', () => {
  const access = createAccess({ lan: false, port: 4317 });
  assert.deepEqual([...access.hosts], ['127.0.0.1:4317', 'localhost:4317']);
  assert.deepEqual(access.check(from('127.0.0.1'), at('/')), { pass: true });
});

test('access: with --lan it also answers to its addresses and its name, and to nothing else', () => {
  const { hosts } = lan();
  for (const name of ['127.0.0.1:4317', '192.168.1.5:4317', 'desk:4317', 'desk.local:4317']) assert.ok(hosts.has(name), name);
  // A page elsewhere that points its own name here (DNS rebinding) is not one of them.
  assert.ok(!hosts.has('evil.example:4317'));
  assert.ok(!hosts.has('192.168.1.5:80'));
});

test('access: this machine needs no key; another device is asked for it', () => {
  const access = lan();
  for (const local of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) assert.deepEqual(access.check(from(local), at('/api/state')), { pass: true });
  assert.deepEqual(access.check(from('192.168.1.9'), at('/')), { ask: true, wrong: false });
  assert.deepEqual(access.check(from('192.168.1.9'), at('/api/state')), { ask: true, wrong: false });
  // Its own address is still the network: only the loopback is this machine for sure.
  assert.deepEqual(access.check(from('192.168.1.5'), at('/')), { ask: true, wrong: false });
});

test('access: the right key is remembered by a cookie and taken out of the address; a wrong one is told so', () => {
  const access = lan();
  const ok = access.check(from('192.168.1.9'), at(`/?lang=th&key=${KEY}`));
  assert.equal(ok.redirect, '/?lang=th');
  assert.match(ok.cookie, new RegExp(`^ocm_key=${KEY}; Max-Age=\\d+; Path=/; HttpOnly; SameSite=Strict$`));
  assert.equal(access.check(from('192.168.1.9'), at(`/?key=${KEY}`)).redirect, '/');
  assert.deepEqual(access.check(from('192.168.1.9'), at('/?key=nope')), { ask: true, wrong: true });
  assert.deepEqual(access.check(from('192.168.1.9'), at('/?key=')), { ask: true, wrong: true });

  const cookie = ok.cookie.split(';')[0];
  assert.deepEqual(access.check(from('192.168.1.9', { cookie: `theme=dark; ${cookie}` }), at('/api/state')), { pass: true });
  assert.deepEqual(access.check(from('192.168.1.9', { cookie: 'ocm_key=nope' }), at('/api/state')), { ask: true, wrong: false });
});

test('access: the key is made once, kept, and replaced when what is kept is not a key', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ocm-key-'));
  try {
    const file = join(dir, 'data', 'access-key');
    const key = loadAccessKey(file);
    assert.match(key, /^[\w-]{32}$/);
    assert.equal(loadAccessKey(file), key);
    assert.equal(readFileSync(file, 'utf8').trim(), key);
    writeFileSync(file, 'short');
    assert.notEqual(loadAccessKey(file), 'short');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('access: the page that asks says where the key is, never what it is; addresses are the network ones', () => {
  assert.ok(!askPage(false).includes(KEY));
  assert.match(askPage(false), /name="key"/);
  assert.ok(!askPage(false).includes('not the right one'));
  assert.match(askPage(true), /not the right one/);
  assert.equal(isLoopback('192.168.1.5'), false);
  assert.deepEqual(lanAddresses({ lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }], eth: [{ family: 'IPv6', internal: false, address: 'fe80::1' }, { family: 'IPv4', internal: false, address: '10.0.0.7' }] }), ['10.0.0.7']);
});
