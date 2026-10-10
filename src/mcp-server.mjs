// The monitor's figures for an AI assistant, over the Model Context Protocol: JSON-RPC 2.0,
// one message per line. Read-only: every tool reports, none changes anything. Nothing is
// sent anywhere by this file; the figures reach an assistant only when you connect one and
// it asks.
import { compactionPoint, configFiles } from './opencode-config.mjs';
import { shownChanges } from './config-changes.mjs';
import { takeawaysOf } from './takeaways.mjs';
import { existsSync } from 'node:fs';

const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

export const INSTRUCTIONS =
  "Figures about how the user's OpenCode coding agent has been working on this machine: time, prompts, permissions, tools, MCP servers, model speed, tokens, compactions, and what the monitor suggests looking at. " +
  'Everything here is read-only: these tools cannot change OpenCode or its settings. ' +
  'Start with opencode_takeaways, then opencode_stats for the figures behind one. ' +
  'If a change to opencode.json would help, show the user the exact edit and the figure it is based on, and make it only after they agree; opencode_settings says which files hold the settings. ' +
  'Session titles, project names, file paths and commands in the results are the user\'s own work: use them to answer, do not repeat them elsewhere.';

const PERIOD = { type: 'integer', enum: [7, 14, 30], description: 'How many days back, ending now. Default 14.' };
const SESSION = { type: 'string', description: 'Only this session: an id from opencode_sessions. Leave out for every session.' };

/**
 * The tools, each { name, description, inputSchema, run(args) -> any JSON }.
 * @param {object} deps
 * @param {(days: number, session?: string|null) => object} deps.stats  from createStatsSource
 * @param {object} deps.opencode   from loadOpencodeConfig
 * @param {object} deps.cfg
 * @param {(key: string, vars?: object) => string} deps.t  English strings
 * @param {{list: (since?: number) => object[]}} deps.configChanges
 * @param {(text: string) => string} deps.redact
 */
export function buildTools({ stats, opencode, cfg, t, configChanges, redact, outputTokenMax = null, now = () => Date.now() }) {
  const told = list => list.map(k => ({ what: t(`takeaways.${k.id}`, k.vars), toChange: k.tone === 'act', figures: k.vars, chapter: k.anchor.replace('stats-', '') }));
  const period = s => ({ from: new Date(s.range.from).toISOString(), to: new Date(s.range.to).toISOString(), days: s.range.days });

  return [
    {
      name: 'opencode_takeaways',
      description: 'A few things worth knowing about the period, each a fixed rule over the figures with a minimum of evidence (nothing is guessed). An empty list means no rule held, not that nothing was looked for. `toChange` marks the ones with something to change.',
      inputSchema: { type: 'object', properties: { days: PERIOD, session: SESSION } },
      run: ({ days, session }) => {
        const s = stats(days, session);
        return { period: period(s), session: s.session, takeaways: told(s.takeaways ?? takeawaysOf(s)) };
      },
    },
    {
      name: 'opencode_stats',
      description: 'The figures for a period: time waiting for the user and time the agent worked, how that time split (reading the prompt, thinking, writing, tools), how prompts ended, permissions asked most, files changed, plans, tools and their failures, MCP servers, model speed, tokens and cost. Times are milliseconds. With `session`, also how that session\'s context filled and where it was compacted.',
      inputSchema: { type: 'object', properties: { days: PERIOD, session: SESSION, daily: { type: 'boolean', description: 'Also the figures per day. Default false.' } } },
      run: ({ days, session, daily }) => {
        const { range, sessions, takeaways, compare, daily: perDay, ...rest } = stats(days, session);
        return { period: period({ range }), ...rest, takeaways: told(takeaways ?? []), ...(daily ? { daily: perDay } : {}) };
      },
    },
    {
      name: 'opencode_sessions',
      description: 'The top-level sessions of a period, most recent first, with what each took: agent time, time waiting for the user, compactions, tokens, cost, tool calls. Use an id from here as `session` in the other tools.',
      inputSchema: { type: 'object', properties: { days: PERIOD } },
      run: ({ days }) => {
        const s = stats(days);
        return { period: period(s), sessions: s.sessions.map(x => ({ ...x, lastAt: new Date(x.lastAt).toISOString() })) };
      },
    },
    {
      name: 'opencode_settings',
      description: 'What OpenCode is set to, as far as it matters for the figures: each model\'s context, input and output limits and the size at which OpenCode compacts a session of it, the compaction settings, the MCP servers and whether each is switched on, and which config files exist. No keys, addresses or commands.',
      inputSchema: { type: 'object', properties: {} },
      run: () => {
        // Only the models used in the last 30 days: OpenCode's catalogue has thousands.
        const used = stats(30).speed.models.map(m => m.model);
        const models = used.map(model => {
          const context = opencode.limits.get(model) ?? null;
          const reserve = opencode.reserves.get(model);
          return { model, context, input: reserve?.input ?? null, output: reserve?.output ?? null, compactsAt: compactionPoint(context, reserve, { ...opencode.compaction, outputTokenMax }) };
        });
        return {
          models,
          modelsNote: 'The models used in the last 30 days, most used first. compactsAt is OpenCode\'s own rule applied to the global config (a project\'s config may differ); null means the limits are not known or it never compacts on its own.',
          compaction: { auto: opencode.compaction.auto ?? true, reserved: opencode.compaction.reserved ?? null, outputTokenMax },
          mcpServers: opencode.mcp.map(m => ({ name: m.name, type: m.type, enabled: m.enabled })),
          configFiles: configFiles(cfg.opencodeConfigDir).filter(f => existsSync(f)).map(f => f.replaceAll('\\', '/')),
          configFilesNote: 'Global. A project may have its own opencode.json or .opencode/opencode.json, which is applied over these.',
        };
      },
    },
    {
      name: 'opencode_config_changes',
      description: 'Saves of OpenCode\'s config that changed a setting, newest first, as the monitor recorded them while it ran: which setting, and from what to what. A value marked hidden (an address, a command) is not kept, only that it changed. Use the date with opencode_stats to see the days before and after.',
      inputSchema: { type: 'object', properties: { days: { type: 'integer', minimum: 1, maximum: 30, description: 'How many days back. Default 30.' } } },
      run: ({ days }) => {
        const back = Math.min(30, Math.max(1, Number.isInteger(days) ? days : 30));
        return { changes: shownChanges(configChanges.list(now() - back * 86_400_000), { redact, configDir: cfg.opencodeConfigDir }).map(c => ({ ...c, at: new Date(c.t).toISOString() })) };
      },
    },
  ];
}

/**
 * The protocol, one message in and at most one out.
 * @returns {(message: object) => object|null}  null for a notification, which gets no reply
 */
export function createMcpServer({ tools, version = '0' }) {
  const byName = new Map(tools.map(tool => [tool.name, tool]));
  const fail = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

  const methods = {
    initialize: params => ({
      // The client's version when we speak it, else our newest; the client decides if that will do.
      protocolVersion: PROTOCOLS.includes(params?.protocolVersion) ? params.protocolVersion : PROTOCOLS[0],
      capabilities: { tools: {} },
      serverInfo: { name: 'opencode-monitor', version },
      instructions: INSTRUCTIONS,
    }),
    ping: () => ({}),
    'tools/list': () => ({
      tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } })),
    }),
    'tools/call': params => {
      const tool = byName.get(params?.name);
      if (!tool) throw Object.assign(new Error(`Unknown tool: ${String(params?.name).slice(0, 80)}`), { code: -32602 });
      const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
      try {
        return { content: [{ type: 'text', text: JSON.stringify(tool.run(args)) }] };
      } catch (err) {
        // A tool that failed is an answer the assistant can read, not a protocol error.
        return { content: [{ type: 'text', text: `The figures are not available right now: ${err.code ?? err.message}` }], isError: true };
      }
    },
  };

  return function handle(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      // A reply to something we never asked is ignored; anything else is not a request.
      return message && typeof message === 'object' && !Array.isArray(message) && ('result' in message || 'error' in message) ? null : fail(message?.id, -32600, 'Not a JSON-RPC 2.0 request.');
    }
    const isNotification = !('id' in message);
    const method = Object.hasOwn(methods, message.method) ? methods[message.method] : null;
    if (isNotification) return null;
    if (!method) return fail(message.id, -32601, `Unknown method: ${message.method.slice(0, 80)}`);
    try {
      return { jsonrpc: '2.0', id: message.id, result: method(message.params) };
    } catch (err) {
      return fail(message.id, Number.isInteger(err.code) ? err.code : -32603, err.message);
    }
  };
}

/** Reads one JSON message per line from `input` and writes the replies to `output`. */
export function serve(handle, input, output) {
  let buffer = '';
  input.setEncoding('utf8');
  input.on('data', chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (!line) continue;
      let reply;
      try {
        reply = handle(JSON.parse(line));
      } catch {
        reply = { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Not JSON.' } };
      }
      if (reply) output.write(`${JSON.stringify(reply)}\n`);
    }
  });
}
