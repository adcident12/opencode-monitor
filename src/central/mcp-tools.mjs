// OpenCode Central, /mcp on the hub: the monitor's own tools (mcp-server.mjs), answered for each machine the hub has
// from its OpenCode-shaped database. `machine` picks one; without it one machine answers as itself and several answer
// side by side ({ machines: { name: … } }), never added together. Left out or emptied: what only the machine's own disk
// knows (config files, MCP servers, model servers, config saves). Added: opencode_versions. Every answer goes through
// the content net (view.mjs) last.
import { buildTools } from '../mcp-server.mjs';
import { loadTranslator } from '../format.mjs';
import { stripContent } from './view.mjs';

export const CENTRAL_INSTRUCTIONS =
  "Figures about how the user's OpenCode coding agent has been working, on each of the user's machines (the hub collects them; no text, code or paths are kept, only figures, session titles and project folder names). " +
  'Everything here is read-only. Every tool takes `machine`; leave it out to get every machine side by side. ' +
  'For how it has been, start with opencode_takeaways, then opencode_stats. For what a change did, opencode_versions (OpenCode) and the llama.cpp server\'s own MCP (llama_changes) give the moments, opencode_compare the before and after. ' +
  'Propose changes to the user with the figure they rest on; the user makes them. Session titles and project names are the user\'s own work: use them to answer, do not repeat them elsewhere.';

const MACHINE = { type: 'string', description: 'Which machine (as in opencode_versions). Leave out for every machine, side by side.' };
const DROPPED = new Set(['opencode_config_changes']);
const SETTINGS_LOCAL = ['configFiles', 'configFilesNote', 'mcpServers', 'modelServers', 'modelServersNote'];
const iso = t => new Date(t).toISOString();

/**
 * @param {object} deps
 * @param {() => string[]} deps.machines
 * @param {(name: string) => { stats, tasks, overnight, costs, snapshot: () => object, facts: object|null, versions: () => object[] }} deps.contextOf
 * @param {() => {t: number, kind: string}[]} [deps.llamaEvents]  llama.cpp events (llama.mjs), newest last or any order
 * @param {(s: string) => string} deps.redact
 * @param {() => number} [deps.now]
 */
export function buildCentralTools({ machines, contextOf, llamaEvents = () => [], redact, now = () => Date.now() }) {
  const t = loadTranslator('en');
  const toolsOf = name => {
    const c = contextOf(name);
    const o = c.facts?.opencode ?? {};
    const opencode = { limits: new Map(o.limits ?? []), reserves: new Map(o.reserves ?? []), compaction: o.compaction ?? {}, mcp: [], model: o.model ?? null };
    const list = buildTools({
      stats: c.stats, opencode, cfg: { opencodeConfigDir: '\0no-config-on-the-hub' }, t, configChanges: { list: () => [] }, redact,
      outputTokenMax: o.outputTokenMax ?? null, opencodeVersion: () => c.facts?.opencodeVersion ?? null,
      tasks: c.tasks, overnight: c.overnight, costs: c.costs, live: c.snapshot, currentModel: () => o.model ?? null, now,
    });
    return { c, byName: new Map(list.map(x => [x.name, x])) };
  };

  /** The newest moment something changed for this machine: an OpenCode version's first session, or a llama.cpp event. */
  function newestEvent(c) {
    const versions = c.versions();
    const moments = versions.slice(1).map(v => ({ t: v.firstAt, kind: 'opencode:version', what: v.version }));
    for (const e of llamaEvents()) if (e.kind !== 'seen') moments.push({ t: e.t, kind: `llama:${e.kind}`, what: e.profile ?? null });
    return moments.filter(m => m.t <= now()).sort((a, b) => b.t - a.t)[0] ?? null;
  }

  const special = {
    opencode_versions: (c) => ({ current: c.facts?.opencodeVersion ?? null, versions: c.versions().map(v => ({ ...v, firstAt: iso(v.firstAt), lastAt: iso(v.lastAt) })) }),
    opencode_compare: (c, args, tool) => {
      if (args.at) return tool.run(args);
      const event = newestEvent(c);
      if (!event) return { error: 'No OpenCode version change or llama.cpp event is known yet: give `at`.' };
      return { event: { ...event, at: iso(event.t) }, ...tool.run({ ...args, at: iso(event.t) }) };
    },
    opencode_settings: (c, args, tool) => {
      const out = tool.run(args);
      for (const k of SETTINGS_LOCAL) delete out[k];
      return out;
    },
  };

  function runOn(name, toolName, args) {
    const { c, byName } = toolsOf(name);
    const tool = byName.get(toolName);
    const value = special[toolName] ? special[toolName](c, args, tool) : tool.run(args);
    return stripContent('mcp', value);
  }

  // Names, descriptions and arguments only (run is per machine, below).
  const base = buildTools({ stats: () => ({}), opencode: { limits: new Map(), reserves: new Map(), compaction: {}, mcp: [] }, cfg: {}, t, configChanges: { list: () => [] }, redact });
  const shapes = base.filter(x => !DROPPED.has(x.name)).map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
  shapes.push({
    name: 'opencode_versions',
    description: 'Each OpenCode version that wrote a session on the machine, oldest first: when its first and last top-level session began and how many there were, and the version running now. A version\'s first session is the moment to give opencode_compare as `at`.',
    inputSchema: { type: 'object', properties: {} },
  });

  return shapes.map(shape => ({
    ...shape,
    description: `${shape.description} On the hub: per machine (\`machine\`).`,
    inputSchema: { ...shape.inputSchema, properties: { ...shape.inputSchema.properties, machine: MACHINE } },
    run: (args = {}) => {
      const { machine, ...rest } = args;
      const all = machines();
      const one = n => (all.includes(n) ? runOn(n, shape.name, rest) : { error: `No machine "${String(n).slice(0, 40)}". Machines: ${all.join(', ') || 'none yet'}.` });
      if (typeof machine === 'string') return one(machine);
      if (all.length === 1) return { machine: all[0], ...one(all[0]) };
      return { machines: Object.fromEntries(all.map(n => [n, one(n)])) };
    },
  }));
}
