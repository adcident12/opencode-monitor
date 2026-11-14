// OpenCode Central, agent mode (`node server.mjs --agent`): no page, no notifications. Every cycle it runs the
// monitor's own reading of this machine (so OpenCode 2's open prompts and the projects' branches are asked for the
// sessions that need it), reads what changed in opencode.db, collects the local facts, seals one batch to the
// hub's key and queues it. A hub that cannot be reached never stops the agent and never touches OpenCode.
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';
import { ROOT, UserError } from '../config.mjs';
import { openDb } from '../db.mjs';
import { createLogTail } from '../logtail.mjs';
import { createPending, withPending } from '../pending.mjs';
import { createProcessProbe } from '../process.mjs';
import { createGitProbe } from '../git.mjs';
import { createMonitor } from '../monitor.mjs';
import { createRedactor } from '../redact.mjs';
import { loadOpencodeConfig, outputTokenMaxFrom } from '../opencode-config.mjs';
import { createExtractor } from './extract.mjs';
import { collectFacts } from './facts.mjs';
import { createOutbox } from './outbox.mjs';
import { seal } from './seal.mjs';

export const MACHINE = /^[a-z0-9-]{1,32}$/;

/** Refuses central settings an agent cannot run with, naming the field. */
export function validateAgent(c) {
  const bad = (k, why) => { throw new UserError(`central.${k} ${why}`); };
  if (!MACHINE.test(String(c?.machine ?? ''))) bad('machine', 'must be 1-32 of a-z, 0-9 and -, e.g. "laptop".');
  if (!/^https?:\/\/[^\s/]+/.test(String(c?.url ?? ''))) bad('url', 'must be the hub address, e.g. "https://opcm.example".');
  if (!c?.token) bad('token', 'is missing: run --central-token <machine> on the hub.');
  if (!c?.publicKey) bad('publicKey', 'is missing: run --central-init on the hub.');
  if (!Number.isInteger(c?.everyMs) || c.everyMs < 2000) bad('everyMs', 'must be a whole number of milliseconds, at least 2000.');
}

/** POST one envelope to the hub's /ingest; its answer, or an error. */
export function httpSend({ url, token }) {
  return async envelope => {
    const res = await fetch(`${url.replace(/\/+$/, '')}/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(envelope),
      signal: AbortSignal.timeout(15_000),
    });
    const body = await res.json().catch(() => null);
    return res.ok && body?.ok === true ? body : { ok: false, status: res.status };
  };
}

const readJson = (path, fallback) => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; } };
const writeJson = (path, v) => { writeFileSync(`${path}.tmp`, JSON.stringify(v)); renameSync(`${path}.tmp`, path); };

function hmacKeyIn(dir) {
  const path = join(dir, 'hmac.key');
  if (!existsSync(path)) writeFileSync(path, randomBytes(32), { mode: 0o600 });
  return readFileSync(path);
}

/**
 * @param {object} cfg  loadConfig() output with cfg.central
 * @param {{ send?: Function, timer?: boolean, now?: () => number, onSuperseded?: () => void }} [opts]
 *   onSuperseded: called once when a newer agent took over this machine (default: end the process)
 * @returns {{ cycle(): Promise<void>, stop(): void, queued(): number }}
 */
export function runAgent(cfg, { send = httpSend(cfg.central), timer = true, now = Date.now, onSuperseded = superseded } = {}) {
  validateAgent(cfg.central);
  const { machine, publicKey, everyMs } = cfg.central;
  const dir = join(dirname(resolve(ROOT, cfg.history.file)), 'agent');
  mkdirSync(dir, { recursive: true });
  const hmacKey = hmacKeyIn(dir);
  const cursorFile = join(dir, 'cursor.json');
  // The newest agent owns the machine. Stopping the scheduled task on Windows leaves its node child running,
  // so after a restart the older agent finds someone else's id here and stops before it touches the outbox.
  const lockFile = join(dir, 'agent.lock');
  const me = randomBytes(8).toString('hex');
  writeJson(lockFile, { id: me, pid: process.pid, startedAt: now() });

  const db = openDb(cfg.dataDir);
  const pending = db.v2 ? createPending({ ...cfg.opencodeApi, file: join(dir, 'prompts.jsonl'), retentionDays: cfg.history.retentionDays }) : null;
  const log = withPending(createLogTail(join(cfg.dataDir, 'log', 'opencode.log')), pending);
  const probe = createProcessProbe(cfg.processNames, { enabled: cfg.processCheck });
  const git = createGitProbe({ enabled: cfg.work.git });
  const monitor = createMonitor({ db, log, cfg, probe, git, pending, redact: createRedactor(cfg.redact), modelLimits: new Map() });
  // The first sync covers the last sinceDays only: the monitor's figures look back 30 days at most.
  const since = now() - (Number(cfg.central.sinceDays) || 30) * 86_400_000;
  const extractor = createExtractor({ dbPath: join(cfg.dataDir, 'opencode.db'), hmacKey, machine, since });
  const outbox = createOutbox({ dir: join(dir, 'outbox'), send, now });

  let cursor = readJson(cursorFile, {});
  let lastFacts = null;
  let busy = false;
  let stopped = false;

  async function cycle() {
    if (busy || stopped) return;
    if (readJson(lockFile, {}).id !== me) {
      console.error('opencode-monitor agent: a newer agent took over this machine, stopping this one.');
      api.stop();
      onSuperseded();
      return;
    }
    busy = true;
    try {
      await probe.refresh();
      monitor(); // asks OpenCode 2 about open prompts for the sessions with a call running
      const dirs = monitor.directories();
      await git.refresh(dirs);
      let opencode = null;
      try { opencode = { ...loadOpencodeConfig(cfg.opencodeConfigDir), outputTokenMax: outputTokenMaxFrom() }; } catch { opencode = null; }
      const facts = collectFacts({ log, probe, pending, git, directories: dirs, machine, opencode, now: now() });
      const factsKey = JSON.stringify({ ...facts, at: 0 });
      const changedFacts = factsKey !== lastFacts;
      for (let i = 0; i < 20; i++) {
        const r = extractor.next(cursor);
        const rows = r?.rows ?? {};
        const any = Object.keys(rows).length > 0;
        if (!any && !(changedFacts && i === 0)) break;
        outbox.put(seq => seal({ machine, seq, instance: outbox.instance(), sentAt: now(), rows, facts: i === 0 && changedFacts ? facts : null }, publicKey));
        // Queued: only now do these rows count as sent and the cursor move (a failed put reads them again).
        if (r) { extractor.acknowledge(r); cursor = r.cursor; writeJson(cursorFile, cursor); }
        if (!r?.more) break;
      }
      lastFacts = factsKey;
      await outbox.flush();
    } catch (err) {
      console.error(`opencode-monitor agent: ${err?.message ?? err}`);
    } finally {
      busy = false;
    }
  }

  const handle = timer ? setInterval(cycle, everyMs) : null;
  if (timer) cycle();
  const api = {
    cycle,
    queued: () => outbox.pending(),
    stop() { if (stopped) return; stopped = true; if (handle) clearInterval(handle); extractor.close(); db.close?.(); },
  };
  return api;
}

function superseded() { process.exit(0); }
