#!/usr/bin/env node
// The monitor's figures for Claude Code (or any MCP client), over stdio:
//
//   claude mcp add opencode-monitor -- node /path/to/opencode-monitor/mcp.mjs
//
// Read-only, and on its own: it reads OpenCode's data itself, so the monitor does not have
// to be running. Nothing leaves this machine unless the assistant you connected asks for it.

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`opencode-monitor needs Node.js 22.13 or newer (found ${process.versions.node}).`);
  process.exit(1);
}

// stdout carries the protocol and nothing else: whatever would be printed goes to stderr.
console.log = console.error;
console.info = console.error;
const emitWarning = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
  const type = typeof rest[0] === 'string' ? rest[0] : rest[0]?.type ?? warning?.name;
  if (type === 'ExperimentalWarning' && /sqlite/i.test(String(warning?.message ?? warning))) return;
  return emitWarning.call(process, warning, ...rest);
};

const { mcpMain } = await import('./src/mcp-main.mjs');
mcpMain(process.argv.slice(2)).catch(err => {
  console.error(err?.userFacing ? `opencode-monitor: ${err.message}` : err);
  process.exit(1);
});
