import { test } from 'node:test';
import assert from 'node:assert/strict';
import { takeawaysOf } from '../src/takeaways.mjs';

const HOUR = 3_600_000;

// A period with plenty of evidence and nothing worth saying about it.
function quiet() {
  return {
    totals: { sessions: 10, prompts: 40, waitMs: 10 * 60_000, compactions: 5, rereads: 2 },
    usage: { requests: 500, cachedPct: 80 },
    tools: [{ tool: 'read', count: 300, errors: 3 }, { tool: 'bash', count: 100, errors: 5 }],
    mcp: [{ name: 'graft', enabled: true, unused: false, calls: 40, faults: 0 }],
    work: {
      time: { readingMs: HOUR, thinkingMs: HOUR, writingMs: HOUR, toolMs: HOUR },
      turns: { ended: { cut: 0 }, cut: [] },
      permissions: { asked: 2, top: [{ permission: 'bash', pattern: 'npm test', count: 2 }] },
      plans: { total: 20, dropped: 2 },
    },
  };
}
const ids = s => takeawaysOf(s).map(t => t.id);

test('a period with nothing unusual says nothing', () => {
  assert.deepEqual(takeawaysOf(quiet()), []);
});

test('replies cut off at the output limit name the models', () => {
  const s = quiet();
  s.work.turns = { ended: { cut: 2 }, cut: [{ model: 'a/x' }, { model: 'a/x' }, { model: null }] };
  assert.deepEqual(takeawaysOf(s)[0], { id: 'cut_off', tone: 'act', vars: { n: 2, models: 'a/x' }, anchor: 'stats-agent' });
});

test('an unused MCP server needs a few sessions before it is called unused', () => {
  const s = quiet();
  s.mcp.push({ name: 'idle', enabled: true, unused: true, calls: 0, faults: 0 });
  assert.deepEqual(ids(s), ['mcp_unused']);
  s.totals.sessions = 2;
  assert.deepEqual(ids(s), []);
});

test('a permission asked three times suggests a rule', () => {
  const s = quiet();
  s.work.permissions.top[0].count = 3;
  assert.deepEqual(takeawaysOf(s), [{ id: 'permission_repeat', tone: 'act', vars: { n: 3, permission: 'bash', pattern: 'npm test' }, anchor: 'stats-you' }]);
});

test('an MCP server that often did not answer, the worst rate', () => {
  const s = quiet();
  s.mcp.push({ name: 'busy', enabled: true, unused: false, calls: 40, faults: 6 }, { name: 'flaky', enabled: true, unused: false, calls: 10, faults: 4 });
  assert.deepEqual(takeawaysOf(s)[0].vars, { name: 'flaky', n: 4, calls: 10 });
});

test('a few calls not answered out of hundreds is not a broken server', () => {
  const s = quiet();
  s.mcp.push({ name: 'chrome', enabled: true, unused: false, calls: 784, faults: 3 });
  assert.deepEqual(ids(s), []);
});

test('time: only when one part is at least half and there is an hour of it', () => {
  const s = quiet();
  s.work.time = { readingMs: 3 * HOUR, thinkingMs: HOUR, writingMs: HOUR, toolMs: HOUR };
  assert.deepEqual(takeawaysOf(s), [{ id: 'time_readingMs', tone: 'note', vars: { pct: 50, hours: 3 }, anchor: 'stats-agent' }]);
  s.work.time = { readingMs: 0.6 * HOUR, thinkingMs: 0, writingMs: 0, toolMs: 0.3 * HOUR };
  assert.deepEqual(ids(s), []);
});

test('compactions: files read again are named only when there were some', () => {
  const s = quiet();
  s.totals.compactions = 20;
  s.totals.rereads = 0;
  assert.equal(takeawaysOf(s)[0].id, 'compactions');
});

test('compactions: two or more per session', () => {
  const s = quiet();
  s.totals.compactions = 20;
  assert.deepEqual(takeawaysOf(s)[0].vars, { per: 2, sessions: 10, rereads: 2 });
});

test('a low cache share needs fifty requests', () => {
  const s = quiet();
  s.usage.cachedPct = 30;
  assert.deepEqual(ids(s), ['cache_low']);
  s.usage.requests = 49;
  assert.deepEqual(ids(s), []);
  s.usage = { requests: 500, cachedPct: null };
  assert.deepEqual(ids(s), []);
});

test('tool failures: twenty calls or more, and the worst rate', () => {
  const s = quiet();
  s.tools.push({ tool: 'edit', count: 40, errors: 8 }, { tool: 'rare', count: 5, errors: 5 });
  assert.deepEqual(takeawaysOf(s)[0].vars, { tool: 'edit', pct: 20, n: 8, calls: 40 });
});

test('waiting: an hour in all', () => {
  const s = quiet();
  s.totals.waitMs = 1.25 * HOUR;
  assert.deepEqual(takeawaysOf(s)[0].vars, { hours: 1.3, prompts: 40 });
});

test('plans left unfinished: ten items and a third of them', () => {
  const s = quiet();
  s.work.plans = { total: 10, dropped: 3 };
  assert.deepEqual(takeawaysOf(s)[0].vars, { n: 3, total: 10, pct: 30 });
  s.work.plans = { total: 9, dropped: 9 };
  assert.deepEqual(ids(s), []);
});

test('at most five, most useful first', () => {
  const s = quiet();
  s.work.turns = { ended: { cut: 1 }, cut: [] };
  s.mcp.push({ name: 'idle', enabled: true, unused: true, calls: 0, faults: 5 });
  s.work.permissions.top[0].count = 5;
  s.totals.compactions = 30;
  s.usage.cachedPct = 10;
  s.totals.waitMs = 2 * HOUR;
  assert.deepEqual(ids(s), ['cut_off', 'mcp_unused', 'permission_repeat', 'mcp_no_answer', 'compactions_rereads']);
});

test('every takeaway has its sentence in every language, quoting only its own figures', async () => {
  const { readFile } = await import('node:fs/promises');
  const s = quiet();
  s.work.turns = { ended: { cut: 1 }, cut: [{ model: 'a/x' }] };
  s.mcp.push({ name: 'idle', enabled: true, unused: true, calls: 0, faults: 5 });
  s.work.permissions.top[0].count = 5;
  s.totals.compactions = 30;
  s.usage.cachedPct = 10;
  s.totals.waitMs = 2 * HOUR;
  s.tools.push({ tool: 'edit', count: 40, errors: 8 });
  s.work.plans = { total: 10, dropped: 5 };
  const found = [];
  // Each rule on its own, so the limit of five does not hide any; and each time split.
  for (const key of Object.keys(s.work.time)) {
    s.work.time = { readingMs: 0, thinkingMs: 0, writingMs: 0, toolMs: 0, [key]: 2 * HOUR };
    found.push(...takeawaysOf(s).filter(t => t.id.startsWith('time_')));
  }
  for (let skip = 0; skip < 12; skip++) {
    const all = takeawaysOf(s);
    found.push(...all);
    if (!all.length) break;
    // Turn off the first rule that held and look again.
    const off = all[0].id;
    if (off === 'cut_off') s.work.turns = { ended: { cut: 0 }, cut: [] };
    if (off === 'mcp_unused') s.mcp.at(-1).unused = false;
    if (off === 'permission_repeat') s.work.permissions.top = [];
    if (off === 'mcp_no_answer') s.mcp.at(-1).faults = 0;
    if (off.startsWith('time_')) s.work.time = { readingMs: 0, thinkingMs: 0, writingMs: 0, toolMs: 0 };
    if (off === 'compactions_rereads') s.totals.rereads = 0;
    if (off === 'compactions') s.totals.compactions = 0;
    if (off === 'cache_low') s.usage.cachedPct = 90;
    if (off === 'tool_failures') s.tools.pop();
    if (off === 'waited') s.totals.waitMs = 0;
    if (off === 'plans_left') s.work.plans = { total: 10, dropped: 0 };
  }
  const ids = new Set(found.map(t => t.id));
  assert.equal(ids.size, 14);
  for (const lang of ['en', 'th']) {
    const strings = JSON.parse(await readFile(new URL(`../i18n/${lang}.json`, import.meta.url), 'utf8'));
    for (const t of found) {
      const text = strings[`takeaways.${t.id}`];
      assert.ok(text, `${lang}: takeaways.${t.id}`);
      for (const [, name] of text.matchAll(/\{(\w+)\}/g)) assert.ok(name in t.vars, `${lang}: ${t.id} quotes {${name}}`);
    }
  }
});

test('works on a real, empty result', async () => {
  const { computeStats } = await import('../src/stats.mjs');
  const empty = computeStats({ sessions: [], tools: [], messages: [], compactions: [], asks: [], replies: [], eventTimes: new Map(), now: Date.now(), days: 7, stuckMs: 600_000, show: s => s });
  assert.deepEqual(takeawaysOf(empty), []);
});
