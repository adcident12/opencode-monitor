// What `npm run release` checks before it changes anything, as pure functions: text in, the
// problem (or what it found) out. scripts/release.mjs runs them against git and the files.

/** The branch a version is released from: v11.10 for 11.10.0. Null when it is no version. */
export function branchOf(version) {
  const match = /^(\d+)\.(\d+)\.\d+$/.exec(version ?? '');
  return match ? `v${match[1]}.${match[2]}` : null;
}

/** Lines of `git status --porcelain` outside the built page, which is put back as committed. */
export function uncommittedOf(porcelain) {
  return porcelain.split('\n').filter(Boolean).filter(line => !line.slice(3).startsWith('public/'));
}

/**
 * The release notes: the text of the entry "## <version> - <today>" of the changelog.
 * @returns {{ notes: string } | { problem: string }}
 */
export function notesOf(changelog, version, today) {
  const heading = `## ${version} - ${today}`;
  const start = changelog.indexOf(`${heading}\n`);
  if (start < 0) return { problem: `CHANGELOG.md has no "${heading}".` };
  const after = changelog.indexOf('\n## ', start + heading.length);
  const notes = changelog.slice(start + heading.length, after < 0 ? undefined : after).trim();
  return notes ? { notes } : { problem: `the ${version} entry of CHANGELOG.md is empty.` };
}
