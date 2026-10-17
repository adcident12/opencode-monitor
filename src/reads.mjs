// Long prompt reads: a request whose prompt the model server read again, most of it, before
// it could write a word. A prompt the server still holds is read in a moment; one it does not
// (after a compaction, or when its cache was dropped) is read whole, at a few thousand tokens
// a second, and the session waits. Seen in the server's slots while a session waits on it.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

// Fewer tokens than this are read in seconds: not worth a line.
export const LONG_READ_TOKENS = 8192;
const DAY = 86_400_000;

/**
 * Follows each slot from one reading to the next and says when a request has finished reading
 * its prompt: how many tokens, and for how long it was seen reading. A request first seen
 * already writing is not said: when it began reading is not known.
 * @returns {(provider: string, slots: object[], at: number) => object[]} the reads finished now
 */
export function createReadTracker() {
  const tracked = new Map(); // "provider|slot" -> { task, from, done }
  return function track(provider, slots, at) {
    const finished = [];
    for (const slot of slots) {
      const key = `${provider}|${slot.id}`;
      let t = tracked.get(key);
      if (!slot.busy) {
        tracked.delete(key);
        continue;
      }
      if (t?.task !== slot.task) {
        t = { task: slot.task, from: slot.written > 0 ? null : at, done: slot.written > 0 };
        tracked.set(key, t);
      }
      if (!t.done && slot.written > 0) {
        t.done = true;
        if (t.from != null && slot.processed >= LONG_READ_TOKENS) finished.push({ provider, t: t.from, tokens: slot.processed, ms: at - t.from });
      }
    }
    return finished;
  };
}

/**
 * The long reads seen, kept beside the history.
 * @param {object} options
 * @param {string|null} options.file   data/reads.jsonl; null keeps them in memory
 * @param {boolean} [options.readOnly]  for a process that only reads them (the MCP server)
 */
export function createReadLog({ file, retentionDays, readOnly = false, now = Date.now() }) {
  const reads = [];
  if (file && existsSync(file)) {
    const cutoff = now - retentionDays * DAY;
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      try {
        const e = JSON.parse(line);
        if (typeof e?.t === 'number' && e.t >= cutoff && e.tokens > 0) reads.push(e);
      } catch {
        // A broken line says nothing.
      }
    }
  }
  return {
    record(read) {
      if (readOnly) return;
      reads.push(read);
      if (!file) return;
      try {
        mkdirSync(dirname(file), { recursive: true });
        appendFileSync(file, `${JSON.stringify(read)}\n`);
      } catch (err) {
        console.warn(`Could not write ${file}: ${err.code ?? err.message}`);
      }
    },
    /** The long reads that began in [from, to], for the sessions in scope (all, without one). */
    between(from, to, inScope = () => true) {
      return reads.filter(r => r.t >= from && r.t <= to && (!r.session || inScope(r.session)));
    },
  };
}

/** In all: how many, how many tokens, how long the sessions waited on them. */
export function longReadsOf(reads) {
  return {
    count: reads.length,
    tokens: reads.reduce((n, r) => n + r.tokens, 0),
    ms: reads.reduce((n, r) => n + r.ms, 0),
    longest: reads.reduce((best, r) => (!best || r.ms > best.ms ? r : best), null),
  };
}
