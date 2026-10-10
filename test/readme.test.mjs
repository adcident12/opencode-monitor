// The README exists in English and in Thai. A change made to one and forgotten in the other
// is the kind of mistake nobody notices for months, so what can be compared is compared here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const en = readFileSync(join(ROOT, 'README.md'), 'utf8').replaceAll('\r\n', '\n');
const th = readFileSync(join(ROOT, 'README.th.md'), 'utf8').replaceAll('\r\n', '\n');

const headings = text => text.split('\n').filter(l => /^#{1,3} /.test(l)).map(l => l.split(' ')[0]);
const codeBlocks = text => [...text.matchAll(/^```(\w*)\n([\s\S]*?)^```$/gm)].map(m => ({ lang: m[1], body: m[2] }));
const tables = text => text.split(/\n(?!\|)/).map(part => part.split('\n').filter(l => l.startsWith('|'))).filter(rows => rows.length);
// What stands in `code` in the text: names of options, keys, files and commands.
const inlineCode = text => new Set([...text.replace(/^```[\s\S]*?^```$/gm, '').matchAll(/`([^`\n]+)`/g)].map(m => m[1]));

test('each language links to the other, first thing under the title', () => {
  assert.match(en.split('\n').slice(0, 4).join('\n'), /\*\*English\*\* · \[ไทย\]\(README\.th\.md\)/);
  assert.match(th.split('\n').slice(0, 4).join('\n'), /\[English\]\(README\.md\) · \*\*ไทย\*\*/);
});

test('the same sections, in the same order and at the same level', () => {
  assert.deepEqual(headings(th), headings(en));
});

test('the same commands: every shell block is identical', () => {
  const [a, b] = [codeBlocks(en), codeBlocks(th)];
  assert.equal(b.length, a.length);
  a.forEach((block, i) => {
    assert.equal(b[i].lang, block.lang, `block ${i + 1}`);
    if (block.lang === 'sh') assert.equal(b[i].body, block.body, `block ${i + 1}`);
  });
});

test('the file list names the same files, each on the same line', () => {
  const files = text => codeBlocks(text).find(b => b.lang === '').body.trim().split('\n').map(l => l.split(/\s+/)[0]);
  assert.deepEqual(files(th), files(en));
});

test('the same tables, row for row, with the same first column where it is code', () => {
  const [a, b] = [tables(en), tables(th)];
  assert.equal(b.length, a.length);
  a.forEach((rows, i) => {
    assert.equal(b[i].length, rows.length, `table ${i + 1}`);
    rows.forEach((row, r) => {
      const first = line => line.split('|')[1].trim();
      if (first(row).startsWith('`')) assert.equal(first(b[i][r]), first(row), `table ${i + 1}, row ${r + 1}`);
      assert.equal(b[i][r].split('|').length, row.split('|').length, `table ${i + 1}, row ${r + 1}: columns`);
    });
  });
});

test('every option, key, file and command named in one is named in the other', () => {
  const [a, b] = [inlineCode(en), inlineCode(th)];
  assert.deepEqual([...a].filter(x => !b.has(x)), [], 'only in README.md');
  assert.deepEqual([...b].filter(x => !a.has(x)), [], 'only in README.th.md');
});

test('the same links', () => {
  const links = text => [...text.matchAll(/\]\(([^)]+)\)|<(https?:[^>]+)>/g)].map(m => m[1] ?? m[2]).filter(l => !/^README(\.th)?\.md$/.test(l)).sort();
  assert.deepEqual(links(th), links(en));
});
