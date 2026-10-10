#!/usr/bin/env node
// npm run sonar: measures test coverage of the server and of the page, then runs a SonarQube
// scan with it. Needs a SonarQube server and its scanner; nothing here is needed to use the
// monitor, and nothing is sent anywhere but to the server you name.
//
//   SONAR_HOST_URL   the server (default http://localhost:9000)
//   SONAR_TOKEN      its token; SONARQUBE_TOKEN is read too. Passed on in the environment,
//                    never on a command line, and never printed.
//   SONAR_SCANNER_HOME  where sonar-scanner is, when it is not on PATH
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'coverage');
const windows = process.platform === 'win32';

function run(what, command, args, options = {}) {
  console.log(`\n> ${what}`);
  // npx and the scanner are .cmd/.bat files on Windows, which only a shell can start. Every
  // argument here is fixed text from this file, so nothing is left for the shell to misread.
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', shell: windows, ...options });
  if (result.error) throw new Error(`${what}: could not start ${command} (${result.error.code ?? result.error.message})`);
  if (result.status !== 0) throw new Error(`${what} failed (exit ${result.status}).`);
}

/** Coverage reports name files from where the tests ran; the scan wants them from the root. */
function fromRoot(file, prefix = '') {
  const lines = readFileSync(file, 'utf8').split('\n').map(line => (line.startsWith('SF:') ? `SF:${prefix}${line.slice(3).replaceAll('\\', '/')}` : line));
  writeFileSync(file, lines.join('\n'));
}

const token = process.env.SONAR_TOKEN ?? process.env.SONARQUBE_TOKEN;
if (!token) {
  console.error('Set SONAR_TOKEN (or SONARQUBE_TOKEN) to a token of your SonarQube server.');
  process.exit(1);
}
const scannerName = windows ? 'sonar-scanner.bat' : 'sonar-scanner';
const inHome = process.env.SONAR_SCANNER_HOME ? join(process.env.SONAR_SCANNER_HOME, 'bin', scannerName) : null;
const scanner = inHome && existsSync(inHome) ? `"${inHome}"` : scannerName;

try {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  run('Server tests, with coverage', process.execPath, [
    '--test', '--experimental-test-coverage',
    '--test-reporter=lcov', '--test-reporter-destination=coverage/server.lcov',
    '--test-reporter=dot', '--test-reporter-destination=stdout',
    'test/*.test.mjs',
  ], { shell: false });
  fromRoot(join(OUT, 'server.lcov'));

  run('Page tests, with coverage', 'npx', ['vitest', 'run', '--coverage', '--coverage.reporter=lcovonly', '--coverage.reportsDirectory=../coverage/page'], { cwd: join(ROOT, 'dashboard') });
  writeFileSync(join(OUT, 'page.lcov'), readFileSync(join(OUT, 'page', 'lcov.info')));
  fromRoot(join(OUT, 'page.lcov'), 'dashboard/');

  const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Unexpected version in package.json: ${version}`);
  // The address and the token go in the environment, where the scanner reads them.
  const env = { ...process.env, SONAR_TOKEN: token, SONAR_HOST_URL: process.env.SONAR_HOST_URL ?? 'http://localhost:9000' };
  run('SonarQube scan', scanner, [`-Dsonar.projectVersion=${version}`], { env });
} catch (err) {
  console.error(`\n${err.message}`);
  process.exit(1);
}
