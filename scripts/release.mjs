#!/usr/bin/env node
// npm run release -- <version> [--yes]: releases this branch as <version>, the way every
// release has been made, and checks each step first.
//
//   1. The branch is the version's own (v11.10 for 11.10.0), and nothing is left uncommitted
//      but the built page, which is put back as committed (it differs only in its build id).
//   2. CHANGELOG.md has an entry "## <version> - <today>"; its text is the release notes.
//   3. The tests pass, the page's tests pass.
//   4. package.json gets the version; "Release <version>" is committed and tagged v<version>.
//   5. main is moved to it (fast-forward only), and main, the branch and the tag are pushed;
//      a GitHub release is made with gh from the changelog entry.
//
// Without --yes it checks 1 to 3 and says what it would do, changing nothing. RELEASE_TRAILER,
// when set, is added to the release commit's message (a Co-Authored-By line, say).
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const windows = process.platform === 'win32';
// What a command printed; nothing when its output went straight to this terminal (stdio: inherit).
const run = (cmd, args, options = {}) => (execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', shell: windows && cmd === 'npm', ...options }) ?? '').trim();
const git = (...args) => run('git', args);
const fail = message => {
  console.error(`release: ${message}`);
  process.exit(1);
};

const [version, ...rest] = process.argv.slice(2);
const yes = rest.includes('--yes');
if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) fail('give the version: npm run release -- 11.10.0 [--yes]');
const [major, minor] = version.split('.');

// 1. The branch, and nothing uncommitted.
const branch = git('branch', '--show-current');
if (branch !== `v${major}.${minor}`) fail(`this is ${branch}; ${version} is released from v${major}.${minor}.`);
if (git('tag', '--list', `v${version}`)) fail(`v${version} is already tagged.`);
const dirty = git('status', '--porcelain').split('\n').filter(Boolean);
const outsidePage = dirty.filter(line => !line.slice(3).startsWith('public/'));
if (outsidePage.length) fail(`commit or stash these first:\n${outsidePage.join('\n')}`);

// 2. The changelog entry, dated today.
const today = new Date().toLocaleDateString('sv-SE');
const changelog = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');
const heading = `## ${version} - ${today}`;
const start = changelog.indexOf(`${heading}\n`);
if (start < 0) fail(`CHANGELOG.md has no "${heading}".`);
const after = changelog.indexOf('\n## ', start + heading.length);
const notes = changelog.slice(start + heading.length, after < 0 ? undefined : after).trim();
if (!notes) fail(`the ${version} entry of CHANGELOG.md is empty.`);

// 3. The tests.
console.log('release: running the tests...');
run('npm', ['test'], { stdio: 'inherit' });
run('npm', ['test'], { cwd: join(ROOT, 'dashboard'), stdio: 'inherit' });

if (!yes) {
  console.log(`\nrelease: ready. With --yes: package.json ${version}, "Release ${version}" committed and tagged v${version} on ${branch}, main moved to it, main, ${branch} and v${version} pushed, and a GitHub release made from the changelog.`);
  process.exit(0);
}

// 4. The release commit and tag. The built page differs only in its build id: put back.
if (dirty.length) git('checkout', '--', 'public');
const pkgPath = join(ROOT, 'package.json');
const pkg = readFileSync(pkgPath, 'utf8');
writeFileSync(pkgPath, pkg.replace(/"version": "[^"]+"/, `"version": "${version}"`));
git('add', 'package.json');
// A trailer for the commit, such as a Co-Authored-By line, only when RELEASE_TRAILER gives one.
const trailer = process.env.RELEASE_TRAILER ? ['-m', process.env.RELEASE_TRAILER] : [];
git('commit', '-q', '-m', `Release ${version}`, ...trailer);
git('tag', '-a', `v${version}`, '-m', version);

// 5. main, the push, the GitHub release.
git('checkout', '-q', 'main');
git('merge', '--ff-only', '-q', branch);
git('push', '-q', 'origin', 'main', branch, `v${version}`);
const dir = mkdtempSync(join(tmpdir(), 'ocm-release-'));
try {
  const file = join(dir, 'notes.md');
  writeFileSync(file, `${notes}\n`);
  console.log(run('gh', ['release', 'create', `v${version}`, '--title', version, '--notes-file', file]));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(`release: ${version} is out. main is at v${version}.`);
