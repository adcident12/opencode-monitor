// Health of the things the agent depends on: MCP servers, the model server, and any
// services listed in the config. Checks run in the background on their own interval.
import { connect } from 'node:net';
import { isLocalHost } from './audit.mjs';
import { mergeServers } from './mcp.mjs';
import { trimEndOf } from './text.mjs';

const TIMEOUT_MS = 4000;

/**
 * MCP status is inferred, because OpenCode only logs failures:
 *   failed  - an OpenCode that is still running logged a failure, or a tool call could not reach the
 *             server, and no tool of that server has worked since
 *   ok      - a tool of that server completed (and after any failure)
 *   unknown - no evidence either way (never used in the sessions on screen)
 * Connections closed because OpenCode itself quit are not failures (see markShutdowns).
 *
 * @param {object} input
 * @param {{name, type, enabled, scope}[]} input.servers  global and project servers, merged
 * @param {Set<string>} input.liveRuns  OpenCode runs still going (logtail's liveRuns)
 * @param {Map<string, {okAt: number|null, connErrAt: number|null}>} input.use  per server
 */
export function mcpStatus({ servers, failures, liveRuns, use, opencodeRunning }) {
  const names = new Map(servers.map(s => [s.name, s]));
  // A server from a config we could not read is unknown to us until it fails.
  for (const [name, failure] of failures) if (!names.has(name) && liveRuns.has(failure.run)) names.set(name, { name, type: 'local', enabled: true, scope: 'project' });

  return [...names.values()].map(server => {
    const { okAt: lastOkAt = null, connErrAt = null } = use.get(server.name) ?? {};
    const worksSince = t => lastOkAt != null && lastOkAt >= t;
    const logged = failures.get(server.name);
    // Whichever is newer: what the log said, or a call that found the connection gone.
    const candidates = [
      logged && liveRuns.has(logged.run) && !worksSince(logged.t) ? { t: logged.t, kind: logged.kind } : null,
      connErrAt != null && !worksSince(connErrAt) ? { t: connErrAt, kind: 'closed' } : null,
    ].filter(Boolean).sort((a, b) => b.t - a.t);
    const failure = candidates[0] ?? null;
    let status;
    if (!server.enabled) status = 'disabled';
    else if (opencodeRunning === false) status = 'unknown';
    else if (failure) status = 'failed';
    else status = lastOkAt ? 'ok' : 'unknown';
    return {
      name: server.name,
      type: server.type,
      scope: server.scope ?? 'global',
      status,
      kind: status === 'failed' ? failure.kind : null,
      failedAt: status === 'failed' ? failure.t : null,
      lastOkAt,
    };
  });
}

// host:port only; a URL may carry credentials or a path that says too much.
function targetOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

async function httpCheck(url) {
  const t0 = performance.now();
  try {
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
    await res.body?.cancel();
    // Any answer below 500 means it is up; 401/404 just means we asked without credentials.
    return { ok: res.status < 500, status: res.status, ms: Math.round(performance.now() - t0), error: null };
  } catch (err) {
    return { ok: false, status: null, ms: null, error: err.name === 'TimeoutError' ? 'timeout' : 'unreachable' };
  }
}

function tcpCheck(host, port) {
  return new Promise(resolve => {
    const t0 = performance.now();
    const socket = connect({ host, port, timeout: TIMEOUT_MS });
    const done = (ok, error) => {
      socket.destroy();
      resolve({ ok, status: null, ms: ok ? Math.round(performance.now() - t0) : null, error });
    };
    socket.once('connect', () => done(true, null));
    socket.once('timeout', () => done(false, 'timeout'));
    socket.once('error', () => done(false, 'unreachable'));
  });
}

/**
 * @param {object} options
 * @param {object} options.cfg       full config
 * @param {object} options.opencode  result of loadOpencodeConfig
 * @param {object} options.log       log tail
 * @param {object} options.probe     OpenCode process probe
 */
export function createEnvironment({ cfg, opencode, log, probe }) {
  const mode = cfg.environment.modelServers;
  const modelTargets = opencode.providers
    .filter(p => mode === 'all' || (mode === 'local' && isLocalHost(targetOf(p.baseURL))))
    .map(p => ({ name: p.id, target: targetOf(p.baseURL), run: () => httpCheck(`${trimEndOf(p.baseURL, '/')}/models`) }));
  const serviceTargets = (cfg.services ?? [])
    .filter(s => s?.name && (s.url || (s.host && s.port)))
    .map(s => (s.url
      ? { name: String(s.name), target: targetOf(s.url), run: () => httpCheck(s.url) }
      : { name: String(s.name), target: `${s.host}:${s.port}`, run: () => tcpCheck(s.host, Number(s.port)) }));

  let models = modelTargets.map(t => ({ name: t.name, target: t.target, ok: null }));
  let services = serviceTargets.map(t => ({ name: t.name, target: t.target, ok: null }));
  let checkedAt = null;
  let last = 0;
  let busy = false;

  const runAll = targets => Promise.all(targets.map(async t => ({ name: t.name, target: t.target, ...(await t.run()) })));

  async function refresh() {
    if (busy || Date.now() - last < cfg.environment.checkSeconds * 1000) return;
    busy = true;
    try {
      [models, services] = await Promise.all([runAll(modelTargets), runAll(serviceTargets)]);
      checkedAt = Date.now();
    } finally {
      last = Date.now();
      busy = false;
    }
  }

  /**
   * @param {Map<string, {okAt: number|null, connErrAt: number|null}>} mcpUse per MCP server
   * @param {object[]} [projectServers] what the project configs of the sessions on screen add
   */
  function view(mcpUse, projectServers = []) {
    return {
      checkedAt,
      models,
      services,
      mcp: mcpStatus({
        servers: mergeServers(opencode.mcp, projectServers),
        failures: log.mcpFailures(),
        liveRuns: log.liveRuns(),
        use: mcpUse,
        opencodeRunning: probe.running,
      }),
    };
  }

  return { refresh, view };
}
