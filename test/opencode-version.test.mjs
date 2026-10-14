// The OpenCode in use now is the one that started last, as its log says: not the version that
// created the newest session, which a 1.x session carried on in OpenCode 2 keeps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogTail } from '../src/logtail.mjs';

test('the version of the OpenCode that started last', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ocm-version-'));
  const file = join(dir, 'opencode.log');
  try {
    appendFileSync(file, 'timestamp=2026-10-14T03:00:00.000Z level=INFO run=a message="creating instance"\n');
    const log = createLogTail(file);
    log.poll();
    assert.equal(log.opencodeVersion(), null);
    appendFileSync(file, 'timestamp=2026-10-14T03:00:01.000Z level=INFO run=b message="cli starting" version=2.0.27 channel=latest local=false args=[] role=cli\n');
    appendFileSync(file, 'timestamp=2026-10-14T05:00:01.000Z level=INFO run=c message="cli starting" version=2.0.28 channel=latest local=false args=[] role=cli\n');
    log.poll();
    assert.equal(log.opencodeVersion(), '2.0.28');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
