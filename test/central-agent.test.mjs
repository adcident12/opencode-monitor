// OpenCode Central, agent mode: every cycle, what changed in opencode.db and the local facts go into one sealed
// batch; nothing changed means nothing sent; a hub that cannot be reached leaves the batch queued and the agent running.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runAgent, validateAgent } from '../src/central/agent.mjs';
import { generateHubKeys, openSealed } from '../src/central/seal.mjs';
import { DEFAULTS, UserError } from '../src/config.mjs';

const keys = generateHubKeys();
const T = Date.now();

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'ocm-agent-'));
  const db = new DatabaseSync(join(dir, 'opencode.db'));
  db.exec(`
    create table session (id text primary key, parent_id text, directory text, title text, time_created int, time_updated int, version text);
    create table message (id text primary key, session_id text, time_created int, time_updated int, data text);
    create table part (id text primary key, message_id text, session_id text, time_created int, time_updated int, data text);`);
  db.prepare('insert into session values (?,?,?,?,?,?,?)').run('s1', null, join(dir, 'shop'), 'cart', T - 1000, T - 1000, '1.18.35');
  db.prepare('insert into message values (?,?,?,?,?)').run('m1', 's1', T - 900, T - 900, JSON.stringify({ role: 'assistant', tokens: { input: 5, output: 1 } }));
  db.close();
  const cfg = structuredClone(DEFAULTS);
  Object.assign(cfg, { dataDir: dir, processCheck: false, opencodeApi: { enabled: false, command: 'opencode' } });
  cfg.history = { ...cfg.history, file: join(dir, 'data', 'history.jsonl') };
  cfg.work = { ...cfg.work, git: false, processes: false };
  cfg.central = { url: 'http://hub.test:4317', machine: 'poppy', token: 't0k', publicKey: keys.publicKey, everyMs: 10_000 };
  return { dir, cfg };
}

test('a cycle sends one sealed batch: machine, seq, rows, facts', async () => {
  const { dir, cfg } = setup();
  const sent = [];
  const agent = runAgent(cfg, { timer: false, send: async env => { sent.push(openSealed(env, keys.privateKey)); return { ok: true, seq: sent.at(-1).seq }; } });
  try {
    await agent.cycle();
    assert.equal(sent.length, 1);
    const b = sent[0];
    assert.deepEqual([b.machine, b.seq], ['poppy', 1]);
    assert.equal(b.rows.session[0].directory, '/poppy/shop');
    assert.equal(b.rows.message[0].id, 'm1');
    assert.equal(typeof b.facts.at, 'number');
    await agent.cycle();
    assert.equal(sent.length, 1, 'nothing changed: nothing sent');
  } finally { agent.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test('a hub that is down: the batch stays queued, the agent keeps running', async () => {
  const { dir, cfg } = setup();
  const agent = runAgent(cfg, { timer: false, send: async () => { throw new Error('ECONNREFUSED'); } });
  try {
    await agent.cycle();
    await agent.cycle();
    assert.equal(agent.queued(), 1);
  } finally { agent.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test('settings that cannot work are refused, naming the field', () => {
  const base = { url: 'http://h:4317', machine: 'poppy', token: 't', publicKey: keys.publicKey, everyMs: 10_000 };
  assert.doesNotThrow(() => validateAgent(base));
  for (const [k, v] of [['machine', 'Poppy PC'], ['url', 'ftp://x'], ['token', ''], ['publicKey', ''], ['everyMs', 100]]) {
    assert.throws(() => validateAgent({ ...base, [k]: v }), e => e instanceof UserError && e.message.includes(`central.${k}`), k);
  }
});

test('--agent is an option, and starting automatically keeps it', async () => {
  const { parseArgs } = await import('../src/config.mjs');
  const { autostartCommand, serverArgs } = await import('../src/autostart.mjs');
  assert.deepEqual(parseArgs(['--agent', '--central-token', 'poppy']), { agent: true, centralToken: 'poppy' });
  assert.equal(parseArgs(['--central']).central, true);
  assert.equal(parseArgs(['--central-init']).centralInit, true);
  assert.match(autostartCommand({ node: 'node', root: 'C:/m', args: { agent: true } }).args, / --agent$/);
  assert.deepEqual(serverArgs({ agent: true }), ['--agent']);
});

test('a first sync of a big database: every sealed envelope stays under the hub\'s 5 MB, and carries the instance', async () => {
  const { dir, cfg } = setup();
  const db = new DatabaseSync(join(dir, 'opencode.db'));
  const ins = db.prepare('insert into part values (?,?,?,?,?,?)');
  for (let i = 0; i < 300; i++) ins.run(`big${i}`, 'm1', 's1', T - 500, T - 500, JSON.stringify({ type: 'tool', tool: 'read', state: { status: 'completed', output: 'x'.repeat(30_000), time: { start: T - 600, end: T - 500 } } }));
  db.close();
  const sizes = [];
  const ids = new Set();
  const agent = runAgent(cfg, { timer: false, send: async env => { sizes.push(Buffer.byteLength(JSON.stringify(env))); const b = openSealed(env, keys.privateKey); ids.add(b.instance); return { ok: true, seq: b.seq }; } });
  try {
    await agent.cycle();
    assert.ok(sizes.length >= 2, `${sizes.length} batches`);
    assert.ok(Math.max(...sizes) < 5 * 2 ** 20, `largest ${Math.max(...sizes)} bytes`);
    assert.equal(ids.size, 1);
    assert.match([...ids][0], /^[0-9a-f]{16}$/);
  } finally { agent.stop(); rmSync(dir, { recursive: true, force: true }); }
});

test('a second agent on the same machine takes over: the older one stops before sending anything', async () => {
  // Stopping the scheduled task on Windows does not end its node child, so a restart leaves two agents
  // sharing one outbox and one seq; the newest one (the new settings) must be the only one left.
  const { dir, cfg } = setup();
  const sentOld = [], sentNew = [];
  let oldStopped = 0;
  const older = runAgent(cfg, { timer: false, onSuperseded: () => { oldStopped++; }, send: async env => { sentOld.push(env); return { ok: true, seq: 1 }; } });
  const newer = runAgent(cfg, { timer: false, onSuperseded: () => assert.fail('the newest agent must keep running'), send: async env => { sentNew.push(openSealed(env, keys.privateKey)); return { ok: true, seq: sentNew.at(-1).seq }; } });
  try {
    await older.cycle();
    assert.equal(oldStopped, 1, 'the older agent saw it was replaced');
    assert.equal(sentOld.length, 0, 'and sent nothing');
    await older.cycle();
    assert.equal(oldStopped, 1, 'stopped once only');
    await newer.cycle();
    assert.equal(sentNew.length, 1);
  } finally { older.stop(); newer.stop(); rmSync(dir, { recursive: true, force: true }); }
});
