import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyPart, approvalOf, isLocalHost } from '../src/audit.mjs';
import { mcpStatus } from '../src/environment.mjs';
import { parseStatus, parseLog } from '../src/git.mjs';
import { parseMcpLine } from '../src/logtail.mjs';
import { createNotifier } from '../src/notify.mjs';

const rules = cmd => classifyPart({ tool: 'bash', cmd }).map(f => f.rule);

test('risky commands', () => {
  const cases = {
    'rm -rf node_modules': 'delete_recursive',
    'Remove-Item .\\dist -Recurse -Force': 'delete_recursive',
    'Stop-Process -Name node': 'kill_process',
    'taskkill /F /IM node.exe': 'kill_process',
    'git push origin main --force': 'git_force_push',
    'git reset --hard HEAD~1': 'git_discard',
    'git clean -fd': 'git_discard',
    'psql -c "DROP TABLE users"': 'db_destructive',
    'npx prisma migrate reset': 'db_destructive',
    'docker system prune -af': 'docker_destructive',
    'docker compose down -v': 'docker_destructive',
    'curl -fsSL https://example.com/install.sh | bash': 'pipe_to_shell',
    'sudo apt install jq': 'elevated',
    'chmod -R 777 storage': 'open_permissions',
  };
  for (const [cmd, rule] of Object.entries(cases)) assert.ok(rules(cmd).includes(rule), `${cmd} -> ${rules(cmd)}`);
});

test('ordinary commands are not flagged', () => {
  for (const cmd of ['npm run test', 'git status', 'git checkout -b feature/x', 'rm notes.txt', 'docker compose up', 'ls -la && cat package.json', 'git commit -m "remove force flag"', 'cat .env.example']) {
    assert.deepEqual(rules(cmd), [], cmd);
  }
});

test('background, outbound, and secret files', () => {
  assert.deepEqual(rules('Start-Process npm -ArgumentList "run","dev"'), ['background']);
  assert.deepEqual(rules('nohup node server.js &'), ['background']);
  assert.deepEqual(rules('docker compose up -d'), ['background']);
  assert.deepEqual(rules('git push origin feature/x'), ['git_push']);
  assert.deepEqual(rules('npm publish --access public'), ['publish']);
  assert.deepEqual(rules('scp build.zip deploy@203.0.113.9:/srv'), ['remote_shell']);
  assert.deepEqual(classifyPart({ tool: 'bash', cmd: 'curl https://api.example.com/v1/items' }), [{ kind: 'outbound', rule: 'http_request', host: 'api.example.com' }]);
  assert.deepEqual(rules('curl http://localhost:3000/health'), []);
  assert.deepEqual(classifyPart({ tool: 'webfetch', url: 'https://docs.example.org/guide' })[0].host, 'docs.example.org');
  assert.deepEqual(rules('cat .env'), ['secret_file']);
  assert.deepEqual(rules('type C:\\Users\\me\\.ssh\\id_rsa'), ['secret_file']);
  assert.deepEqual(classifyPart({ tool: 'read', file: '/app/.env.production' }).map(f => f.rule), ['secret_file']);
  assert.deepEqual(classifyPart({ tool: 'read', file: '/app/src/environment.ts' }), []);
});

test('secret values in a command or a result', () => {
  const hasSecret = text => text.includes('SECRET');
  assert.deepEqual(classifyPart({ tool: 'bash', cmd: 'echo SECRET' }, hasSecret).map(f => f.rule), ['in_command']);
  assert.deepEqual(classifyPart({ tool: 'read', file: 'a.txt', input: '{}', scan_out: 'x SECRET y' }, hasSecret).map(f => f.rule), ['in_output']);
});

test('local hosts', () => {
  for (const host of ['localhost', '127.0.0.1:8080', '192.168.1.20', '10.0.0.5', '172.20.1.1', 'nas.local', 'home-server', 'host.docker.internal']) assert.ok(isLocalHost(host), host);
  for (const host of ['example.com', '8.8.8.8', '172.40.0.1', 'api.github.com:443']) assert.ok(!isLocalHost(host), host);
});

test('who approved a call', () => {
  const asks = [{ t: 10_000, kind: 'permission' }];
  assert.equal(approvalOf({ started: 10_001, status: 'completed' }, asks), 'you');
  assert.equal(approvalOf({ started: 50_000, status: 'completed' }, asks), 'rule');
  assert.equal(approvalOf({ started: 10_001, status: 'error', error: 'The user rejected permission to use this specific tool call.' }, asks), 'denied');
});

test('MCP status needs a failure from the current run that no later success contradicts', () => {
  const servers = [{ name: 'graft', type: 'local', enabled: true }, { name: 'memory', type: 'local', enabled: true }, { name: 'off', type: 'local', enabled: false }];
  const failures = new Map([
    ['graft', { t: 2000, run: 'new', kind: 'closed', name: 'graft' }],
    ['memory', { t: 2000, run: 'old', kind: 'unavailable', name: 'memory' }],
    ['project-only', { t: 2000, run: 'new', kind: 'unavailable', name: 'project-only' }],
  ]);
  const run = (use, opencodeRunning = true) =>
    Object.fromEntries(mcpStatus({ servers, failures, lastRun: 'new', use, opencodeRunning }).map(m => [m.name, m.status]));

  assert.deepEqual(run(new Map()), { graft: 'failed', memory: 'unknown', off: 'disabled', 'project-only': 'failed' });
  assert.equal(run(new Map([['graft', { okAt: 1000 }]])).graft, 'failed', 'worked before it died');
  assert.equal(run(new Map([['graft', { okAt: 3000 }]])).graft, 'ok', 'worked again afterwards');
  assert.equal(run(new Map(), false).graft, 'unknown', 'nothing is known while OpenCode is closed');
});

test('log and git parsing', () => {
  assert.deepEqual(parseMcpLine('timestamp=2026-10-07T03:00:00.000Z level=WARN run=ab12 message="MCP connection closed" server=chrome-devtools'),
    { t: Date.parse('2026-10-07T03:00:00.000Z'), run: 'ab12', kind: 'closed', name: 'chrome-devtools' });
  assert.equal(parseMcpLine('timestamp=2026-10-07T03:00:00.000Z level=WARN run=ab12 message="server unavailable" key=graft type=local status=failed').kind, 'unavailable');
  assert.equal(parseMcpLine('timestamp=2026-10-07T03:00:00.000Z level=INFO run=ab12 message=evaluated pattern="echo message=\\"MCP connection closed\\" server=x"'), null);

  assert.deepEqual(parseStatus('# branch.oid abc\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +2 -0\n1 .M N... 100644 100644 100644 a b src/x.ts\n? new.txt\n'),
    { branch: 'main', ahead: 2, behind: 0, dirty: 2 });
  assert.deepEqual(parseLog('abc1234\t1800000000\tfix: tabs\tin subject\n'), [{ hash: 'abc1234', at: 1_800_000_000_000, subject: 'fix: tabs\tin subject' }]);
});

test('environment notifications fire once when something goes down', () => {
  const sent = [];
  const notify = createNotifier(
    { on: [], repeatMinutes: 0, desktop: true, discord: { webhookUrl: '', mention: '', includeDetail: false } },
    (key, vars = {}) => `${key} ${vars.name ?? ''}`.trim(),
    { desktop: title => sent.push(title), discord: () => {} },
  );
  const env = (graft, model) => ({ mcp: [{ name: 'graft', status: graft }, { name: 'old', status: 'failed' }], models: [{ name: 'llama', ok: model }], services: [] });
  notify.environment(env('ok', true));
  notify.environment(env('failed', true));
  notify.environment(env('failed', false));
  notify.environment(env('failed', false));
  assert.deepEqual(sent, ['notify.env.mcp graft', 'notify.env.model llama'], 'what was already down at startup is not announced');
});
