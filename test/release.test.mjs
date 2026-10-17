// What `npm run release` checks before it changes anything.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { branchOf, uncommittedOf, notesOf } from '../scripts/release-check.mjs';

test('a version is released from its own branch', () => {
  assert.equal(branchOf('11.10.0'), 'v11.10');
  assert.equal(branchOf('11.10'), null);
  assert.equal(branchOf('v11.10.0'), null);
  assert.equal(branchOf(undefined), null);
});

test('only the built page may be left uncommitted', () => {
  assert.deepEqual(uncommittedOf(''), []);
  assert.deepEqual(uncommittedOf(' M public/index.html\n?? public/_next/static/x.js\n'), []);
  assert.deepEqual(uncommittedOf(' M public/index.html\n M src/stats.mjs\n?? test/new.test.mjs'), [' M src/stats.mjs', '?? test/new.test.mjs']);
});

test('the notes are the entry dated today, up to the next one', () => {
  const changelog = '# Changelog\n\n## 11.11.0 - 2026-10-17\n\n- Prompt cache lost.\n\n## 11.10.0 - 2026-10-16\n\n- Older.\n';
  assert.deepEqual(notesOf(changelog, '11.11.0', '2026-10-17'), { notes: '- Prompt cache lost.' });
  assert.deepEqual(notesOf(changelog, '11.10.0', '2026-10-16'), { notes: '- Older.' });
  assert.deepEqual(notesOf(changelog, '11.11.0', '2026-10-18'), { problem: 'CHANGELOG.md has no "## 11.11.0 - 2026-10-18".' });
  assert.deepEqual(notesOf('## 11.11.0 - 2026-10-17\n\n## 11.10.0 - 2026-10-16\n', '11.11.0', '2026-10-17'), { problem: 'the 11.11.0 entry of CHANGELOG.md is empty.' });
});
