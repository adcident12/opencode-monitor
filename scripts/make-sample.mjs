// Builds a small fake OpenCode data directory (database + log) with one session per state.
// Nothing in it comes from a real transcript. Used by `--sample` and by the tests.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MIN = 60_000;
const HOUR = 60 * MIN;

const SCHEMA = `
create table session (id text primary key, project_id text not null, parent_id text, slug text not null,
  directory text not null, title text not null, version text not null, time_created integer not null,
  time_updated integer not null, time_compacting integer, model text);
create table message (id text primary key, session_id text not null, time_created integer not null,
  time_updated integer not null, data text not null);
create table part (id text primary key, message_id text not null, session_id text not null,
  time_created integer not null, time_updated integer not null, data text not null);
create table todo (session_id text not null, content text not null, status text not null, priority text not null,
  position integer not null, time_created integer not null, time_updated integer not null);
create index part_session_idx on part (session_id);
create index message_session_time_created_id_idx on message (session_id, time_created, id);
`;

// Built at run time so no secret-shaped literal sits in the repository.
const FAKE_TOKEN = 'squ_' + '0123456789abcdef'.repeat(2) + '01234567';

export function buildSample(dir, now = Date.now()) {
  dir = resolve(dir);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'log'), { recursive: true });
  const db = new DatabaseSync(join(dir, 'opencode.db'));
  db.exec(SCHEMA);

  const insertSession = db.prepare('insert into session values (?,?,?,?,?,?,?,?,?,?,?)');
  const insertMessage = db.prepare('insert into message values (?,?,?,?,?)');
  const insertPart = db.prepare('insert into part values (?,?,?,?,?,?)');
  const logLines = [];
  let seq = 0;
  const id = prefix => `${prefix}_${String(++seq).padStart(6, '0')}`;
  const model = JSON.stringify({ id: 'sample-model', providerID: 'sample' });

  function session(title, project, { ageMs, parent = null, updatedAgoMs = 0 }) {
    const sid = id('ses');
    insertSession.run(sid, 'prj_sample', parent, 'sample', `/work/${project}`, title, '1.18.35', now - ageMs, now - updatedAgoMs, null, model);
    return sid;
  }
  function message(sid, role, agoMs, extra = {}) {
    const mid = id('msg');
    const t = now - agoMs;
    insertMessage.run(mid, sid, t, t, JSON.stringify({ role, time: { created: t }, ...extra }));
    return mid;
  }
  function part(sid, mid, agoMs, data, updatedAgoMs = agoMs) {
    insertPart.run(id('prt'), mid, sid, now - agoMs, now - updatedAgoMs, JSON.stringify(data));
  }
  const tool = (name, status, input, agoMs, extra = {}) => ({
    type: 'tool', tool: name, callID: id('call'),
    state: { status, input, time: { start: now - agoMs, ...(status === 'running' ? {} : { end: now - agoMs + 900 }) }, ...extra },
  });
  const stepFinish = (reason, context) => ({ type: 'step-finish', reason, tokens: { input: 1200, output: 300, cache: { read: context - 1200, write: 0 } } });
  const assistant = (extra = {}) => ({ modelID: 'sample-model', providerID: 'sample', ...extra });
  function ask(agoMs, permission, patterns) {
    const ts = new Date(now - agoMs).toISOString();
    logLines.push(`timestamp=${ts} level=INFO run=sample00 message=asking id=${id('per')} permission=${permission} patterns=${JSON.stringify(JSON.stringify(patterns))}`);
  }
  const insertTodo = db.prepare('insert into todo values (?,?,?,?,?,?,?)');
  function todos(sid, items) {
    items.forEach(([status, content], i) => insertTodo.run(sid, content, status, 'medium', i, now, now));
  }
  // A finished earlier turn, so sessions have some history and a context size.
  function history(sid, agoMs, context, turns = 1) {
    for (let i = 0; i < turns; i++) {
      const at = agoMs + (turns - i) * 2 * MIN;
      message(sid, 'user', at);
      const mid = message(sid, 'assistant', at - 20_000, assistant({ finish: 'stop', time: { created: now - at, completed: now - at + 30_000 } }));
      part(sid, mid, at - 20_000, tool('read', 'completed', { filePath: `/work/src/file${i}.ts` }, at - 20_000));
      part(sid, mid, at - 25_000, stepFinish('stop', context));
    }
  }

  // 1. Working: a test run that started 40 seconds ago.
  {
    const sid = session('Add pagination to the orders list', 'shop-api', { ageMs: 35 * MIN });
    history(sid, 10 * MIN, 31_000, 3);
    message(sid, 'user', 3 * MIN);
    const mid = message(sid, 'assistant', 50_000, assistant());
    part(sid, mid, 130_000, tool('graft_graft_find_code', 'completed', { query: 'orders list' }, 130_000));
    part(sid, mid, 2 * MIN, tool('read', 'completed', { filePath: '/work/shop-api/src/orders/list.ts' }, 2 * MIN));
    part(sid, mid, 100_000, tool('edit', 'completed', { filePath: '/work/shop-api/src/orders/list.ts' }, 100_000));
    part(sid, mid, 70_000, tool('bash', 'error', { command: 'npm run lint' }, 70_000, { error: 'Error: 2 problems' }));
    part(sid, mid, 40_000, tool('bash', 'running', { command: 'npm run test -- orders', description: 'Run the orders tests' }, 40_000, {
      metadata: { output: '> shop-api@1.4.0 test\n> vitest run orders\n\n ✓ orders/list.test.ts (8 tests) 412ms\n ✓ orders/cursor.test.ts (5 tests) 96ms\n ❯ orders/export.test.ts 3/11\n' },
    }), 4000);
    todos(sid, [
      ['completed', 'Add cursor parameters to the orders query'],
      ['completed', 'Return next/previous cursors from the endpoint'],
      ['in_progress', 'Run the orders tests and fix failures'],
      ['pending', 'Update the API docs'],
    ]);
  }

  // 2. Waiting: permission prompt unanswered since last night.
  {
    const sid = session('Wire up the staging environment', 'clinic-app', { ageMs: 11 * HOUR, updatedAgoMs: 8 * HOUR + 10 * MIN });
    history(sid, 9 * HOUR, 54_000, 4);
    const at = 8 * HOUR + 10 * MIN;
    message(sid, 'user', at + MIN);
    const mid = message(sid, 'assistant', at + 5000, assistant());
    part(sid, mid, at + 2000, tool('read', 'running', { filePath: '/work/clinic-app/.env' }, at), at);
    ask(at, 'read', ['/work/clinic-app/.env']);
  }

  // 3. Waiting: the agent asked a question.
  {
    const sid = session('Choose a date library', 'shop-web', { ageMs: 50 * MIN, updatedAgoMs: 12 * MIN });
    history(sid, 20 * MIN, 18_000, 2);
    message(sid, 'user', 14 * MIN);
    const mid = message(sid, 'assistant', 13 * MIN, assistant());
    part(sid, mid, 12 * MIN, tool('question', 'running', { questions: [{ question: 'Keep moment.js or migrate to date-fns?', options: [] }] }, 12 * MIN));
  }

  // 4. Probably stuck: a dev server command that never returned.
  {
    const sid = session('Fix the login redirect', 'clinic-app', { ageMs: 2 * HOUR, updatedAgoMs: 35 * MIN });
    history(sid, 50 * MIN, 47_000, 5);
    message(sid, 'user', 37 * MIN);
    const mid = message(sid, 'assistant', 36 * MIN, assistant());
    part(sid, mid, 35 * MIN, tool('bash', 'running', { command: 'Start-Process npm -ArgumentList "run","dev" -RedirectStandardOutput dev.log', description: 'Start the dev server' }, 35 * MIN, {
      metadata: { output: '> clinic-app@0.9.2 dev\n> vite\n\n  VITE v6.0.1  ready in 512 ms\n  ➜  Local:   http://localhost:5173/\n' },
    }), 34 * MIN + 40_000);
  }

  // 5. Finished.
  {
    const sid = session('Rename UserCard props', 'shop-web', { ageMs: 3 * HOUR, updatedAgoMs: 25 * MIN });
    history(sid, 25 * MIN, 22_000, 3);
  }

  // 6. Error: the model request failed.
  {
    const sid = session('Generate the OpenAPI client', 'shop-api', { ageMs: 90 * MIN, updatedAgoMs: 18 * MIN });
    history(sid, 30 * MIN, 12_000, 1);
    message(sid, 'user', 19 * MIN);
    message(sid, 'assistant', 18 * MIN, assistant({ error: { name: 'APIError', data: { message: 'connection refused' } } }));
  }

  // 7. Working but unhealthy: nearly full context, many compactions, a repeated command,
  //    and a token in a command line (shown redacted).
  {
    const sid = session('Migrate reports to the new schema', 'clinic-app', { ageMs: 20 * HOUR });
    history(sid, 40 * MIN, 60_000, 2);
    message(sid, 'user', 30 * MIN);
    const mid = message(sid, 'assistant', 29 * MIN, assistant({ finish: 'tool-calls', time: { created: now - 29 * MIN, completed: now - 2 * MIN } }));
    for (let i = 0; i < 19; i++) part(sid, mid, 28 * MIN - i * 1000, { type: 'compaction', auto: true });
    for (let i = 0; i < 5; i++) {
      part(sid, mid, 20 * MIN - i * MIN, tool('bash', i % 2 ? 'error' : 'completed', { command: 'npx prisma migrate dev' }, 20 * MIN - i * MIN, i % 2 ? { error: 'Error: P3006 migration failed to apply' } : { output: 'ok' }));
    }
    part(sid, mid, 3 * MIN, tool('bash', 'completed', { command: `curl -H "Authorization: Bearer ${FAKE_TOKEN}" http://localhost:9000/api/issues/search` }, 3 * MIN, { output: '{}' }));
    part(sid, mid, 2 * MIN, stepFinish('tool-calls', 120_500));
    const next = message(sid, 'assistant', 90_000, assistant());
    part(sid, next, 30_000, tool('bash', 'running', { command: `sonar-scanner -Dsonar.token=${FAKE_TOKEN}` }, 30_000));
  }

  // 8. Parent whose subagent is blocked on a permission prompt.
  {
    const parent = session('Audit dependencies', 'shop-api', { ageMs: 40 * MIN, updatedAgoMs: 6 * MIN });
    message(parent, 'user', 9 * MIN);
    const mid = message(parent, 'assistant', 8 * MIN, assistant());
    part(parent, mid, 7 * MIN, tool('task', 'running', { description: 'Check outdated packages', subagent_type: 'general' }, 7 * MIN));

    const child = session('Check outdated packages (subagent)', 'shop-api', { ageMs: 7 * MIN, parent, updatedAgoMs: 6 * MIN });
    message(child, 'user', 7 * MIN);
    const cmid = message(child, 'assistant', 6 * MIN + 5000, assistant());
    part(child, cmid, 6 * MIN + 1000, tool('bash', 'running', { command: 'npm outdated --json' }, 6 * MIN), 6 * MIN);
    ask(6 * MIN, 'bash', ['npm outdated --json']);
  }

  // 9. Finished, but left things to review: a forced push, a killed process, a secret file read.
  {
    const sid = session('Clean up the release branch', 'shop-web', { ageMs: 4 * HOUR, updatedAgoMs: 50 * MIN });
    message(sid, 'user', 70 * MIN);
    const at = 55 * MIN;
    const mid = message(sid, 'assistant', 69 * MIN, assistant({ finish: 'stop', time: { created: now - 69 * MIN, completed: now - 50 * MIN } }));
    part(sid, mid, 68 * MIN, tool('read', 'completed', { filePath: '/work/shop-web/.env.production' }, 68 * MIN, { output: `API_URL=https://api.example.test\nSONAR_TOKEN=${FAKE_TOKEN}\n` }));
    part(sid, mid, 66 * MIN, tool('edit', 'completed', { filePath: '/work/shop-web/src/release.ts' }, 66 * MIN));
    part(sid, mid, 64 * MIN, tool('chrome-devtools_take_snapshot', 'completed', {}, 64 * MIN));
    part(sid, mid, 62 * MIN, tool('bash', 'completed', { command: 'Stop-Process -Name node -Force' }, 62 * MIN, { output: '' }));
    part(sid, mid, 60 * MIN, tool('bash', 'completed', { command: 'curl -s https://registry.example.com/shop-web/latest' }, 60 * MIN, { output: '{}' }));
    part(sid, mid, at, tool('bash', 'completed', { command: 'git push --force origin release/2.4' }, at, { output: 'ok' }));
    ask(at, 'bash', ['git push --force origin release/2.4']);
    part(sid, mid, 52 * MIN, tool('bash', 'error', { command: 'rm -rf dist node_modules' }, 52 * MIN, { error: 'The user rejected permission to use this specific tool call.' }));
    part(sid, mid, 51 * MIN, stepFinish('stop', 26_000));
  }

  // MCP servers: one that never started in this run and one that died after the kill above.
  const mcpLine = (agoMs, text) => logLines.push(`timestamp=${new Date(now - agoMs).toISOString()} level=WARN run=sample00 message=${text}`);
  mcpLine(4 * HOUR, '"server unavailable" key=sonarqube type=local status=failed');
  mcpLine(62 * MIN - 2000, '"MCP connection closed" server=chrome-devtools');

  // A fake OpenCode config, so the sample has a model limit, MCP servers, and a model server.
  writeFileSync(join(dir, 'opencode.json'), JSON.stringify({
    provider: {
      sample: { options: { baseURL: 'http://127.0.0.1:9/v1' }, models: { 'sample-model': { limit: { context: 131_072 } } } },
    },
    mcp: {
      'chrome-devtools': { type: 'local', command: ['npx', 'chrome-devtools-mcp'] },
      graft: { type: 'local', command: ['graft', 'mcp'] },
      sonarqube: { type: 'local', command: ['sonarqube-mcp'] },
      github: { type: 'remote', url: 'https://example.test/mcp', enabled: false },
    },
  }, null, 2));

  db.close();
  logLines.sort();
  writeFileSync(join(dir, 'log', 'opencode.log'), logLines.join('\n') + '\n');
  return dir;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(`Sample data written to ${buildSample(process.argv[2] ?? 'sample')}`);
}
