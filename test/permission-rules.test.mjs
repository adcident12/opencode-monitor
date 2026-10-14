// A permission prompt that a rule in the config lets through now is fixed: not suggested again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wildcardMatch, allowedByRules } from '../src/opencode-config.mjs';
import { takeawaysOf } from '../src/takeaways.mjs';
import { permissionsOf } from '../src/work.mjs';
import { computeStats } from '../src/stats.mjs';

const T = 1_791_900_000_000;

test("OpenCode's own wildcard: * crosses separators, either slash, any case on Windows", () => {
  assert.equal(wildcardMatch('C:\\Users\\me\\npm-cache\\_npx\\d66\\shadcn\\dist\\*', 'C:\\Users\\me\\npm-cache\\_npx\\*', 'win32'), true);
  assert.equal(wildcardMatch('c:/users/ME/Temp/x', 'C:\\Users\\me\\Temp\\*', 'win32'), true);
  assert.equal(wildcardMatch('/home/Me/x', '/home/me/*', 'linux'), false);
  assert.equal(wildcardMatch('git status --short', 'git status *', 'linux'), true);
  assert.equal(wildcardMatch('git status', 'git status *', 'linux'), true);
  assert.equal(wildcardMatch('a.b', 'a?b', 'linux'), true);
  assert.equal(wildcardMatch('a(b)', 'a(b)', 'linux'), true);
});

test('allowed now: by the last rule that matches, for every pattern of the prompt', () => {
  const rules = [
    { action: 'external_directory', resource: '*', effect: 'ask' },
    { action: 'external_directory', resource: 'C:\\Users\\me\\npm-cache\\_npx\\*', effect: 'allow' },
    { action: 'external_directory', resource: 'C:\\Users\\me\\npm-cache\\_npx\\bad\\*', effect: 'deny' },
  ];
  const allowed = (perm, pat) => allowedByRules(rules, perm, pat, 'win32');
  assert.equal(allowed('external_directory', 'C:\\Users\\me\\npm-cache\\_npx\\d66\\shadcn\\dist\\*'), true);
  assert.equal(allowed('external_directory', 'C:\\Users\\me\\npm-cache\\_npx\\bad\\x'), false);
  assert.equal(allowed('external_directory', 'C:\\Users\\me\\npm-cache\\_npx\\a\\* , E:\\data\\*'), false);
  assert.equal(allowed('bash', 'ls'), false);
  assert.equal(allowedByRules([], 'bash', 'ls'), false);
});

test('the takeaway skips a prompt a rule lets through now, and names the next one', () => {
  const rules = [{ action: 'external_directory', resource: 'C:\\Users\\me\\npm-cache\\_npx\\*', effect: 'allow' }];
  const allowed = (perm, pat) => allowedByRules(rules, perm, pat, 'win32');
  const ask = (patterns, t) => ({ kind: 'permission', permission: 'external_directory', patterns, t, answeredAt: t + 1000, waitMs: 1000 });
  const prompts = [
    ...Array.from({ length: 12 }, (_, i) => ask('C:\\Users\\me\\npm-cache\\_npx\\d66\\shadcn\\dist\\*', T + i)),
    ...Array.from({ length: 4 }, (_, i) => ask('E:\\data\\*', T + 100 + i)),
  ];
  const permissions = permissionsOf(prompts, x => String(x ?? ''), allowed);
  assert.deepEqual(permissions.top.map(g => [g.count, g.allowedNow]), [[12, true], [4, false]]);
  // A period with nothing else in it, and these prompts.
  const stats = computeStats({ sessions: [], tools: [], messages: [], compactions: [], asks: [], replies: new Map(), eventTimes: new Map(), now: T, days: 7, stuckMs: 600_000, show: x => String(x ?? '') });
  stats.work.permissions = permissions;
  const said = takeawaysOf(stats).find(x => x.id === 'permission_repeat');
  assert.deepEqual(said?.vars, { n: 4, permission: 'external_directory', pattern: 'E:\\data\\*' });
});
