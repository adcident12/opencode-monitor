// Runs the test suite for CI and turns each failure into a GitHub error annotation.
// Locally, `npm test` is all you need.
import { run } from 'node:test';
import { spec } from 'node:test/reporters';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'test');
const files = readdirSync(testDir).filter(name => name.endsWith('.test.mjs')).map(name => join(testDir, name));

// Annotation text is a single line; GitHub decodes these escapes.
const oneLine = text => String(text).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');

const stream = run({ files, concurrency: true });
stream.on('test:fail', event => {
  process.exitCode = 1;
  const cause = event.details?.error?.cause ?? event.details?.error;
  console.log(`::error title=${oneLine(event.name)}::${oneLine(cause?.message ?? cause ?? 'failed').slice(0, 1500)}`);
});
stream.compose(spec).pipe(process.stdout);
