// OpenCode Central, agent side: sealed batches wait on disk, one file each, until the hub says it has them. Sent in
// order; a failure waits 5 s, doubling to 10 minutes. Past the size or age cap the oldest are dropped and counted.
import { mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const FIRST_WAIT = 5_000;
const MAX_WAIT = 600_000;
// <seq>-<queued at>.json: order and age without opening the file
const name = (seq, at) => `${String(seq).padStart(10, '0')}-${at}.json`;
const atOf = f => Number(f.slice(11, -5));

/**
 * @param {{ dir: string, send: (envelope: object) => Promise<{ok: boolean, seq?: number}>, maxBytes?: number, maxAgeMs?: number, now?: () => number }} o
 */
export function createOutbox({ dir, send, maxBytes = 200 * 2 ** 20, maxAgeMs = 30 * 86_400_000, now = Date.now }) {
  mkdirSync(dir, { recursive: true });
  const seqFile = join(dir, 'seq');
  const dropFile = join(dir, 'dropped');
  const instanceFile = join(dir, 'instance');
  const rejectDir = join(dir, 'rejected');
  // Which queue this is. A queue whose seq is lost or unreadable starts again at 1 under a new instance, so the hub
  // (which skips seqs it has seen) knows to count from the start again instead of dropping every batch.
  const readSeq = () => { try { const n = Number(readFileSync(seqFile, 'utf8')); return Number.isInteger(n) && n >= 0 ? n : null; } catch { return null; } };
  let seq = readSeq();
  let instance = existsSync(instanceFile) ? readFileSync(instanceFile, 'utf8').trim() : '';
  if (seq === null || !/^[0-9a-f]{16}$/.test(instance)) {
    seq = 0;
    instance = randomBytes(8).toString('hex');
  }
  let dropped = existsSync(dropFile) ? Number(readFileSync(dropFile, 'utf8')) || 0 : 0;
  let wait = 0;
  let nextTry = 0;
  let busy = false;

  const writeAtomic = (path, text) => { writeFileSync(`${path}.tmp`, text); renameSync(`${path}.tmp`, path); };
  writeAtomic(instanceFile, instance);
  writeAtomic(seqFile, String(seq));
  let rejected = 0;
  /** A batch the hub refused for good (400 malformed, 413 too big): kept aside for a look, never sent again. */
  function reject(f) {
    mkdirSync(rejectDir, { recursive: true });
    try { renameSync(join(dir, f), join(rejectDir, f)); } catch { try { unlinkSync(join(dir, f)); } catch { /* gone */ } }
    rejected++;
  }
  const FOR_GOOD = new Set([400, 413]);
  const files = () => readdirSync(dir).filter(f => /^\d{10}-\d+\.json$/.test(f)).sort();

  function drop(f) {
    try { unlinkSync(join(dir, f)); } catch { /* already gone */ }
    dropped++;
  }

  function enforceCaps() {
    let list = files().map(f => ({ f, size: statSync(join(dir, f)).size, at: atOf(f) }));
    const cutoff = now() - maxAgeMs;
    let n = 0;
    for (const e of list) if (e.at < cutoff) { drop(e.f); n++; }
    list = list.filter(e => e.at >= cutoff);
    let total = list.reduce((s, e) => s + e.size, 0);
    while (total > maxBytes && list.length) { const e = list.shift(); drop(e.f); total -= e.size; n++; }
    if (n) writeAtomic(dropFile, String(dropped));
  }

  return {
    /** Stores build(seq) as the next batch; returns its seq. */
    put(build) {
      seq++;
      writeAtomic(seqFile, String(seq));
      const path = join(dir, name(seq, now()));
      writeAtomic(path, JSON.stringify(build(seq)));
      return seq;
    },
    /** Sends what is due, in order. Never throws. */
    async flush() {
      if (busy) return { sent: 0, kept: files().length, dropped: 0, rejected: 0 };
      busy = true;
      const droppedBefore = dropped;
      const rejectedBefore = rejected;
      let sent = 0;
      try {
        enforceCaps();
        if (now() < nextTry) return { sent, kept: files().length, dropped: dropped - droppedBefore, rejected: 0 };
        for (const f of files()) {
          let ok = false;
          let status = 0;
          try {
            const r = await send(JSON.parse(readFileSync(join(dir, f), 'utf8')));
            ok = r?.ok === true;
            status = Number(r?.status) || 0;
          } catch { ok = false; }
          if (!ok && FOR_GOOD.has(status)) { reject(f); continue; }
          if (!ok) {
            wait = Math.min(MAX_WAIT, wait ? wait * 2 : FIRST_WAIT);
            nextTry = now() + wait;
            break;
          }
          try { unlinkSync(join(dir, f)); } catch { /* locked (antivirus): sent again next time, the hub skips its seq */ }
          sent++;
          wait = 0;
          nextTry = 0;
        }
        return { sent, kept: files().length, dropped: dropped - droppedBefore, rejected: rejected - rejectedBefore };
      } finally {
        busy = false;
      }
    },
    nextTryAt: () => nextTry,
    instance: () => instance,
    droppedTotal: () => dropped,
    pending: () => files().length,
  };
}
