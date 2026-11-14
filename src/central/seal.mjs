// OpenCode Central: a batch sealed to the hub's X25519 key. A fresh key pair per batch, HKDF-SHA256, AES-256-GCM.
// TLS ends at the home's reverse proxy; this keeps the batch unreadable there and anywhere else on the way.
import { generateKeyPairSync, createPublicKey, createPrivateKey, diffieHellman, hkdfSync, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

const INFO = 'ocm-central-v1';
export class SealError extends Error {}

const b64 = buf => Buffer.from(buf).toString('base64url');
const unb64 = s => Buffer.from(s, 'base64url');
const pub = x => createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x }, format: 'jwk' });
const priv = (x, d) => createPrivateKey({ key: { kty: 'OKP', crv: 'X25519', x, d }, format: 'jwk' });

/** A new hub key pair: publicKey (give to agents) and privateKey (stays on the hub), both base64url. */
export function generateHubKeys() {
  const { privateKey } = generateKeyPairSync('x25519');
  const jwk = privateKey.export({ format: 'jwk' });
  return { publicKey: jwk.x, privateKey: `${jwk.x}.${jwk.d}` };
}

function keyFor(shared, epk) {
  return Buffer.from(hkdfSync('sha256', shared, unb64(epk), INFO, 32));
}

/** @returns {{ v: 1, epk: string, iv: string, ct: string, tag: string }} */
export function seal(obj, publicKey) {
  const eph = generateKeyPairSync('x25519');
  const epk = eph.publicKey.export({ format: 'jwk' }).x;
  const key = keyFor(diffieHellman({ privateKey: eph.privateKey, publicKey: pub(publicKey) }), epk);
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(INFO));
  const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return { v: 1, epk, iv: b64(iv), ct: b64(ct), tag: b64(c.getAuthTag()) };
}

/** The batch inside an envelope; SealError for anything that is not a valid envelope for this key. */
export function openSealed(env, privateKey) {
  try {
    if (!env || typeof env !== 'object' || env.v !== 1 || !['epk', 'iv', 'ct', 'tag'].every(k => typeof env[k] === 'string')) throw new Error('shape');
    const [x, d] = String(privateKey).split('.');
    const key = keyFor(diffieHellman({ privateKey: priv(x, d), publicKey: pub(env.epk) }), env.epk);
    const dc = createDecipheriv('aes-256-gcm', key, unb64(env.iv));
    dc.setAAD(Buffer.from(INFO));
    dc.setAuthTag(unb64(env.tag));
    return JSON.parse(Buffer.concat([dc.update(unb64(env.ct)), dc.final()]).toString('utf8'));
  } catch {
    throw new SealError('envelope refused');
  }
}
