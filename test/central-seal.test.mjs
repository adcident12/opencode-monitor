// OpenCode Central: every batch is sealed to the hub's key, so nothing on the way (TLS ends at the home's NPM)
// can read it, and any change to it is refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateHubKeys, seal, openSealed, SealError } from '../src/central/seal.mjs';

const keys = generateHubKeys();
const batch = { machine: 'poppy', seq: 7, rows: { session: [{ id: 's1', title: 'cart' }] } };

test('round trip: what was sealed comes back the same', () => {
  assert.deepEqual(openSealed(seal(batch, keys.publicKey), keys.privateKey), batch);
});

test('two seals of the same batch differ (a fresh key and IV each time)', () => {
  const a = seal(batch, keys.publicKey);
  const b = seal(batch, keys.publicKey);
  assert.notEqual(a.ct, b.ct);
  assert.notEqual(a.epk, b.epk);
});

test('the sealed form carries no plaintext', () => {
  assert.doesNotMatch(JSON.stringify(seal(batch, keys.publicKey)), /poppy|cart/);
});

test('any changed byte, a wrong key, or a malformed envelope is refused with SealError', () => {
  const env = seal(batch, keys.publicKey);
  const flip = s => (s[0] === 'A' ? 'B' : 'A') + s.slice(1);
  for (const k of ['ct', 'tag', 'epk', 'iv']) assert.throws(() => openSealed({ ...env, [k]: flip(env[k]) }, keys.privateKey), SealError, k);
  assert.throws(() => openSealed(env, generateHubKeys().privateKey), SealError);
  for (const bad of [null, {}, { ...env, v: 2 }, { ...env, ct: 5 }, 'x']) assert.throws(() => openSealed(bad, keys.privateKey), SealError);
});
