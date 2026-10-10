#!/usr/bin/env node
// Entry point. Checks the Node version before anything imports node:sqlite.

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(
    `opencode-monitor needs Node.js 22.13 or newer (found ${process.versions.node}).\n` +
    'It reads the OpenCode database with the built-in node:sqlite module.'
  );
  process.exit(1);
}

// node:sqlite still prints an ExperimentalWarning on every start; hide only that one.
const emitWarning = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
  const type = typeof rest[0] === 'string' ? rest[0] : rest[0]?.type ?? warning?.name;
  if (type === 'ExperimentalWarning' && /sqlite/i.test(String(warning?.message ?? warning))) return;
  return emitWarning.call(process, warning, ...rest);
};

const { main } = await import('./src/main.mjs');
try {
  await main(process.argv.slice(2));
} catch (err) {
  console.error(err?.userFacing ? `opencode-monitor: ${err.message}` : err);
  process.exit(1);
}
