import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRedactor, clip } from '../src/redact.mjs';

const redact = createRedactor();
// Assembled at run time so the repository holds no secret-shaped literals.
const sonar = 'squ_' + 'ab12'.repeat(10);
const github = 'ghp_' + 'A1b2C3d4'.repeat(5);

test('hides tokens with a known prefix', () => {
  for (const token of [sonar, github, 'sk-' + 'x1'.repeat(20), 'AKIA' + 'ABCDEFGH12345678']) {
    const out = redact(`curl -u ${token}: http://localhost:9000`);
    assert.ok(!out.includes(token), out);
    assert.ok(out.includes('[redacted]'));
  }
});

test('hides passwords inside connection URLs but keeps the rest', () => {
  assert.equal(redact('psql postgres://app:hunter2@db.local:5432/shop'), 'psql postgres://app:[redacted]@db.local:5432/shop');
});

test('hides values of secret-sounding names', () => {
  const cases = [
    'SONARQUBE_TOKEN=abc123def',
    '$env:MYSQL_PASS = "p@ss word"',
    '"apiKey": "something-long"',
    'mysql --password=topsecret -u root',
    'login --token abcdefgh',
    'Authorization: Bearer abcdefghijklmnop',
    'client_secret: zzz999',
  ];
  for (const text of cases) {
    const out = redact(text);
    assert.ok(out.includes('[redacted]'), `${text} -> ${out}`);
    assert.ok(!/abc123def|p@ss word|something-long|topsecret|abcdefgh|zzz999/.test(out), out);
  }
});

test('leaves ordinary text alone', () => {
  for (const text of ['npm run test -- orders', 'max_tokens=4096', 'git commit -m "bypass cache"', 'GIT_AUTHOR_NAME=Sam', 'tests passed: 12']) {
    assert.equal(redact(text), text);
  }
});

test('hides private keys and Discord webhooks', () => {
  assert.equal(redact('-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----'), '[redacted]');
  assert.equal(redact('https://discord.com/api/webhooks/123456/' + 'tok-en_'.repeat(6)), '[redacted]');
});

test('extra patterns and the off switch', () => {
  assert.equal(createRedactor({ extraPatterns: ['corp-\\d+'] })('id corp-4411'), 'id [redacted]');
  assert.equal(createRedactor({ enabled: false })(sonar), sonar);
});

test('clip flattens whitespace and shortens', () => {
  assert.equal(clip('a\n  b', 10), 'a b');
  assert.equal(clip('abcdefghij', 5), 'abcd…');
});
