// The git probe reads a directory the agent controls, so most of this is about what it refuses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { parseHead, isSafeLocalPath, isSafeSegment, createGitProbe, UNREADABLE } from '../src/git.mjs';

const HASH = 'c'.repeat(40);

test('HEAD is parsed strictly', () => {
  assert.deepEqual(parseHead('ref: refs/heads/feature/login\n'), { branch: 'feature/login', detached: false });
  assert.deepEqual(parseHead(`${HASH}\n`), { branch: 'ccccccc', detached: true });
  for (const text of ['garbage', '', 'ref: refs/tags/v1\n', 'ref: refs/heads/a b\n', `ref: refs/heads/main\n${HASH}\n`, 'ref: refs/heads/x\nextra line\n', `prefix ${HASH}\n`, `ref: refs/heads/${'x'.repeat(300)}\n`]) {
    assert.deepEqual(parseHead(text), { branch: null, detached: false }, JSON.stringify(text.slice(0, 40)));
  }
});

test('path checks', () => {
  for (const path of ['\\\\evil.example\\share\\.git', '//evil.example/share/.git', '\\\\.\\pipe\\x', '\\\\?\\C:\\x', '/dev/zero', '/proc/self/environ', 'relative/path', '', 'C:repo', tmpdir() + sep + 'NUL', tmpdir() + sep + 'x' + sep + 'COM1.txt']) {
    assert.equal(isSafeLocalPath(path), false, path);
  }
  assert.equal(isSafeLocalPath(tmpdir()), true);
  for (const name of ['', '.', '..', 'a/b', 'a\\b', 'C:', 'file::$DATA', 'NUL', 'nul.txt', 'COM1', 'LPT9', 'CONIN$', 'aux', 'NUL.', 'aux ', 'trailing.', 'q?', 'tab\tname']) {
    assert.equal(isSafeSegment(name), false, JSON.stringify(name));
  }
  for (const name of ['HEAD', 'refs', 'feature-1', 'release_2.4', 'console', 'com10x', '.git']) assert.equal(isSafeSegment(name), true, name);
});

test('a real repository: branch is read, from a subdirectory too, and nothing in its config is run', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ocm-git-'));
  const marker = join(dir, 'ran.txt');
  const git = (...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.test', '-c', 'commit.gpgsign=false', ...args], { stdio: 'pipe' });
  try {
    git('init', '-q', '-b', 'work/demo');
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    git('add', '.');
    git('commit', '-q', '-m', 'first commit');
    // What a hostile repository could set up: programs git would run for status or log.
    const touch = `node -e "require('fs').writeFileSync(process.argv[1],'x')" "${marker.replace(/\\/g, '/')}"`;
    writeFileSync(join(dir, '.gitattributes'), '* filter=evil\n');
    for (const key of ['filter.evil.clean', 'filter.evil.smudge', 'core.fsmonitor', 'gpg.program']) git('config', key, touch);
    writeFileSync(join(dir, 'a.txt'), 'two\n');
    const sub = join(dir, 'packages', 'app');
    mkdirSync(sub, { recursive: true });

    const probe = createGitProbe();
    await probe.refresh([dir, sub]);
    for (const where of [dir, sub]) assert.deepEqual(probe.get(where), { branch: 'work/demo', detached: false, state: 'ok' });
    assert.equal(existsSync(marker), false, 'a program from the repository config was run');

    git('-c', 'filter.evil.clean=', '-c', 'filter.evil.smudge=', '-c', 'core.fsmonitor=false', 'checkout', '-q', '--detach');
    const again = createGitProbe();
    await again.refresh([dir]);
    assert.equal(again.get(dir).detached, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('layouts that are refused are "unreadable", never a clean result and never followed', async () => {
  // realpath: on macOS the temp directory sits behind a link.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ocm-ptr-')));
  try {
    const repo = name => {
      mkdirSync(join(root, name, '.git'), { recursive: true });
      return join(root, name);
    };
    // Somewhere a link or pointer could aim at, holding a perfectly good HEAD.
    const decoy = join(root, 'decoy');
    mkdirSync(decoy);
    writeFileSync(join(decoy, 'HEAD'), 'ref: refs/heads/decoy\n');

    const good = repo('good');
    writeFileSync(join(good, '.git', 'HEAD'), 'ref: refs/heads/main\n');

    // .git is a file pointing elsewhere (worktree/submodule style, or anything else).
    const pointers = ['gitdir: ' + decoy, 'gitdir: \\\\evil.example\\share\\.git\\worktrees\\x', 'gitdir: //evil.example/share/.git', 'gitdir: ../decoy'].map((text, i) => {
      mkdirSync(join(root, `pointer${i}`));
      writeFileSync(join(root, `pointer${i}`, '.git'), text + '\n');
      return join(root, `pointer${i}`);
    });

    // .git is a link to a directory; HEAD is a link to a file; HEAD is a directory; HEAD is huge; HEAD is missing.
    const gitIsLink = join(root, 'git-is-link');
    mkdirSync(gitIsLink);
    symlinkSync(decoy, join(gitIsLink, '.git'), 'junction');
    const headIsLink = repo('head-is-link');
    let fileLinks = true;
    try {
      symlinkSync(join(decoy, 'HEAD'), join(headIsLink, '.git', 'HEAD'), 'file');
    } catch {
      fileLinks = false; // Windows without the privilege to create file links
    }
    const headIsDir = repo('head-is-dir');
    mkdirSync(join(headIsDir, '.git', 'HEAD'));
    const headIsHuge = repo('head-is-huge');
    writeFileSync(join(headIsHuge, '.git', 'HEAD'), 'ref: refs/heads/main\n' + 'x'.repeat(10_000));
    const headMissing = repo('head-missing');

    // HEAD with content that is not one of git's two forms: readable, but no branch is claimed.
    const odd = repo('odd-head');
    writeFileSync(join(odd, '.git', 'HEAD'), 'ref: refs/../../../decoy/HEAD\n');

    const share = '\\\\evil.example\\share\\project';
    let clock = 1_000_000;
    const probe = createGitProbe({ everyMs: 15_000, now: () => clock });
    assert.equal(probe.get(good), undefined, 'not looked at yet is its own answer');
    await probe.refresh([good, ...pointers, gitIsLink, headIsLink, headIsDir, headIsHuge, headMissing, odd, share]);

    assert.deepEqual(probe.get(good), { branch: 'main', detached: false, state: 'ok' });
    for (const refused of [...pointers, gitIsLink, headIsDir, headIsHuge, headMissing, share]) assert.equal(probe.get(refused), UNREADABLE, refused);
    if (fileLinks) assert.equal(probe.get(headIsLink), UNREADABLE, 'HEAD as a link');
    assert.deepEqual(probe.get(odd), { branch: null, detached: false, state: 'ok' });

    // A result nobody has refreshed for a long time is no longer vouched for.
    clock += 15_000 * 4 + 1;
    assert.equal(probe.get(good), UNREADABLE);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a switched-off probe never reports anything', async () => {
  const probe = createGitProbe({ enabled: false });
  await probe.refresh([tmpdir()]);
  assert.equal(probe.get(tmpdir()), undefined);
});
