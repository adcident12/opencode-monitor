// Polls the data sources and builds the snapshot the page shows.
// Everything that leaves this module has been through the redactor.
import { basename, relative, isAbsolute } from 'node:path';
import { deriveState, deriveHealth, deriveProgress, describePart, bubbleChildren } from './state.mjs';
import { classifyPart, approvalOf, FLAG_KINDS } from './audit.mjs';
import { clip } from './redact.mjs';
import { createServerMatcher, faultOf } from './mcp.mjs';
import { compactionPoint } from './opencode-config.mjs';
import { OUTPUT_TAIL_CHARS } from './db.mjs';

const SUMMARY_CHARS = 240;
const OUTPUT_LINES = 6;
const REVIEW_GROUPS = 40;
const REVIEW_EXAMPLES = 25;
const FILE_TOOLS = new Set(['edit', 'write', 'multiedit', 'apply_patch']);

// The same file arrives from edit tools and from patches written differently (slashes, and on
// Windows, letter case). One entry per file, shown as first seen, dated by the latest touch.
function touch(files, path, at) {
  const key = process.platform === 'win32' ? path.replaceAll('\\', '/').toLowerCase() : path;
  const entry = files.get(key);
  files.set(key, { path: entry?.path ?? path, at: Math.max(at, entry?.at ?? 0) });
}

/**
 * @param {object} deps
 * @param {object} deps.db, deps.log, deps.cfg, deps.probe
 * @param {(text: string) => string} deps.redact
 * @param {Map<string, number>} deps.modelLimits
 * @param {string[]} [deps.mcpNames]   MCP server names from the global config
 * @param {object} [deps.projectMcp]   from createProjectMcp: servers project configs add
 * @param {object} [deps.environment]  from createEnvironment
 * @param {object} [deps.git]          from createGitProbe
 */
export function createMonitor({ db, log, cfg, redact, modelLimits, modelReserves = new Map(), compactionSettings = {}, outputTokenMax = null, probe, mcpNames = [], projectMcp = null, environment = null, git = null, leftovers = null }) {
  const cache = new Map(); // session id -> { byId, sorted, maxUpdated, digest }
  const show = (text, max = SUMMARY_CHARS) => clip(redact(String(text ?? '').slice(0, 4000)), max);
  const hasSecret = text => redact(text) !== text;
  const ignoredRules = new Set(cfg.review?.ignoreRules ?? []);

  // Last lines a running command has printed, and when the last of them arrived.
  function outputOf(part) {
    if (part.status !== 'running' || !part.out_len) return null;
    let text = part.out_tail ?? '';
    // The tail may start mid-line, and half a secret would slip past the redactor.
    if (part.out_len > OUTPUT_TAIL_CHARS) text = text.slice(text.indexOf('\n') + 1);
    const lines = redact(text).split(/\r?\n/).map(line => line.trimEnd()).filter(Boolean).slice(-OUTPUT_LINES);
    return { lines: lines.map(line => (line.length > 200 ? line.slice(0, 199) + '…' : line)), chars: part.out_len, at: part.time_updated };
  }

  // When this tool last worked, or last found its MCP server gone.
  function noteToolUse(toolUse, p) {
    const lost = p.status === 'error' && faultOf(p.error) === 'connection';
    if (p.status !== 'completed' && !lost) return;
    const use = toolUse.get(p.tool) ?? { okAt: null, connErrAt: null };
    use[lost ? 'connErrAt' : 'okAt'] = p.time_updated;
    toolUse.set(p.tool, use);
  }

  // The newest success and the newest lost connection of each MCP server, over every
  // session on screen.
  function mcpUseOf(serverOf) {
    const newer = (a, b) => (a == null || b > a ? b : a);
    const mcpUse = new Map(); // server -> { okAt, connErrAt }
    for (const entry of cache.values()) {
      for (const [tool, use] of entry.digest.toolUse) {
        const server = serverOf(tool)?.server;
        if (!server) continue;
        const known = mcpUse.get(server) ?? { okAt: null, connErrAt: null };
        if (use.okAt != null) known.okAt = newer(known.okAt, use.okAt);
        if (use.connErrAt != null) known.connErrAt = newer(known.connErrAt, use.connErrAt);
        mcpUse.set(server, known);
      }
    }
    return mcpUse;
  }

  // Per-session facts that only change when parts change: flagged calls, files touched,
  // and when each tool last worked or last found its server gone. Kept per tool name, not
  // per MCP server: which server a tool belongs to can change when a project config does.
  function digestOf(sorted) {
    const flagged = [];
    const files = new Map(); // path -> last touched
    const toolUse = new Map(); // tool name -> { okAt, connErrAt }
    for (const p of sorted) {
      if (p.type === 'patch' && p.fileList) {
        for (const file of p.fileList) touch(files, file, p.time_created);
      } else if (p.type === 'tool') {
        if (FILE_TOOLS.has(p.tool) && p.status === 'completed' && p.file) touch(files, p.file, p.time_updated);
        if (p.flags.length) flagged.push(p);
        noteToolUse(toolUse, p);
      }
    }
    return { flagged, files, toolUse };
  }

  function loadParts(sessionId) {
    const stats = db.partStats(sessionId);
    let entry = cache.get(sessionId);
    const merge = (rows, into) => {
      for (const row of rows) {
        if (row.type === 'tool') row.flags = classifyPart(row, hasSecret);
        else if (row.type === 'patch') {
          try {
            row.fileList = JSON.parse(row.files ?? '[]').filter(f => typeof f === 'string');
          } catch {
            row.fileList = [];
          }
        }
        // Tool results were only needed for the secret check above.
        delete row.scan_out;
        delete row.files;
        into.byId.set(row.id, row);
        if (row.time_updated > into.maxUpdated) into.maxUpdated = row.time_updated;
      }
      into.sorted = [...into.byId.values()].sort((a, b) => a.time_created - b.time_created || (a.id < b.id ? -1 : 1));
      into.digest = digestOf(into.sorted);
    };
    const full = () => {
      entry = { byId: new Map(), sorted: [], maxUpdated: 0, digest: null };
      merge(db.parts(sessionId), entry);
      cache.set(sessionId, entry);
    };
    if (!entry) full();
    else if ((stats.max_updated ?? 0) > entry.maxUpdated) merge(db.parts(sessionId, entry.maxUpdated), entry);
    // Rows can disappear (revert, pruning); a count mismatch means the cache is no longer right.
    if (entry.byId.size !== stats.count) full();
    return entry;
  }

  function contextLimitFor(session, messages) {
    let provider, model;
    try {
      const m = JSON.parse(session.model ?? 'null');
      provider = m?.providerID;
      model = m?.id ?? m?.modelID;
    } catch {
      // Older rows have no model column value.
    }
    const lastAssistant = messages.findLast(m => m.role === 'assistant' && m.model_id);
    provider ??= lastAssistant?.provider_id;
    model ??= lastAssistant?.model_id;
    const key = `${provider}/${model}`;
    const project = projectMcp?.settingsFor(session.directory);
    // What OpenCode itself uses for this session: the project's config over the global one.
    const opencodeLimit = project?.limits.get(key) ?? modelLimits.get(key) ?? null;
    const reserve = project?.reserves.get(key) ?? modelReserves.get(key);
    const settings = { ...compactionSettings, ...project?.compaction, outputTokenMax };
    // config.json can name a window the monitor could not read; OpenCode's own value wins
    // for the compaction point, because that is the one OpenCode compacts by.
    const limit = cfg.contextLimit.models[key] ?? cfg.contextLimit.models[model] ?? opencodeLimit ?? cfg.contextLimit.default;
    return { model: model ?? null, limit: limit ?? null, autoCompact: settings.auto !== false, compactAt: compactionPoint(opencodeLimit ?? limit ?? null, reserve, settings) };
  }

  const shortPath = (file, root) => {
    const rel = root && isAbsolute(file) ? relative(root, file) : file;
    return show(rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : file, 120).replaceAll('\\', '/');
  };

  // What the agent did to the project: files it touched, and the state of the repository.
  function workOf(session, digest) {
    const recent = [...digest.files.values()].sort((a, b) => b.at - a.at).slice(0, 5).map(({ path }) => shortPath(path, session.directory));
    // null: git reading is off, or the directory is not in a repository.
    // undefined: not looked at yet; shown as "checking", never as a clean result.
    const found = !git || !cfg.work.git ? null : git.get(session.directory);
    const info = found === undefined ? { branch: null, detached: false, state: 'pending' } : found;
    const onProtected = Boolean(info?.branch) && !info.detached && cfg.work.protectedBranches.includes(info.branch);
    return {
      files: { count: digest.files.size, recent },
      git: info && {
        branch: info.branch ? show(info.branch, 80) : null,
        detached: info.detached,
        state: info.state, // 'ok' | 'unreadable' | 'pending'
      },
      // The session is on a branch you probably meant to protect. Not tied to the files
      // counted above: those only cover the edit tools, and a change made through a shell
      // command (sed, git commit, a script) would otherwise slip past the warning.
      warnProtected: onProtected,
      // Not knowing the branch is not the same as being on a safe one.
      warnUnknownBranch: Boolean(info) && !info.branch && info.state !== 'pending',
      running: leftoversOf(digest),
    };
  }

  // Processes this session's background commands started that are still running.
  // null when the check is off or has not been able to run.
  function leftoversOf(digest) {
    if (!leftovers?.enabled) return null;
    const items = [];
    for (const p of digest.flagged) {
      if (!p.flags.some(f => f.rule === 'background')) continue;
      for (const proc of leftovers.get(p.id)) {
        items.push({
          pid: proc.pid,
          pids: proc.pids,
          name: show(proc.name, 60),
          command: show(proc.command, 240),
          startedAt: proc.startedAt,
          ports: proc.ports,
          processes: proc.processes,
          from: show(describePart(p), 200),
        });
      }
    }
    return { failed: leftovers.failed(), items: items.sort((a, b) => b.startedAt - a.startedAt) };
  }

  // Tool calls worth a second look, newest first, with who let each one run.
  function reviewOf(digest, asks) {
    const counts = Object.fromEntries(FLAG_KINDS.map(kind => [kind, 0]));
    // One entry per rule (and per host for requests): twenty process kills are one thing
    // to look at, not twenty. Grouping must not hide anything, though: every distinct
    // command in a group is listed, so a harmless `rm -rf dist` cannot cover for an
    // earlier `rm -rf ~`, and whatever does not fit is counted and said out loud.
    const groups = new Map();
    let ignored = 0; // matches left out by review.ignoreRules; reported, never silent
    for (let i = digest.flagged.length - 1; i >= 0; i--) {
      const p = digest.flagged[i];
      let approval;
      let text;
      for (const flag of p.flags) {
        if (ignoredRules.has(flag.rule)) {
          ignored++;
          continue;
        }
        counts[flag.kind]++;
        approval ??= approvalOf(p, asks);
        text ??= describePart(p);
        const key = `${flag.rule}|${flag.host ?? ''}`;
        let group = groups.get(key);
        if (!group) {
          group = {
            kind: flag.kind,
            rule: flag.rule,
            host: flag.host ? show(flag.host, 80) : null,
            at: p.started ?? p.time_created,
            count: 0,
            approvals: { asked: 0, rule: 0, refused: 0 },
            distinct: new Map(), // raw command text -> { count, at, tool, approvals }
          };
          groups.set(key, group);
        }
        group.count++;
        group.approvals[approval]++;
        let example = group.distinct.get(text);
        if (!example) {
          example = { tool: p.tool, at: p.started ?? p.time_created, count: 0, approvals: { asked: 0, rule: 0, refused: 0 } };
          group.distinct.set(text, example);
        }
        example.count++;
        example.approvals[approval]++;
      }
    }
    // Sorted before cutting, so a flood of low-priority entries cannot push risky ones out.
    const sorted = [...groups.values()].sort((a, b) => FLAG_KINDS.indexOf(a.kind) - FLAG_KINDS.indexOf(b.kind) || b.at - a.at);
    const items = sorted.slice(0, REVIEW_GROUPS).map(({ distinct, ...group }) => ({
      ...group,
      examples: [...distinct].slice(0, REVIEW_EXAMPLES).map(([raw, example]) => ({ ...example, text: show(raw, 200) })),
      // Distinct commands in this group that are not listed above.
      hiddenExamples: Math.max(0, distinct.size - REVIEW_EXAMPLES),
    }));
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    return { counts, total, items, ignored, more: total - items.reduce((sum, item) => sum + item.count, 0) };
  }

  function buildSession(session, now, asks) {
    const { sorted: parts, maxUpdated, digest } = loadParts(session.id);
    const messages = db.lastMessages(session.id);
    const derived = deriveState({ session, parts, messages, asks, now, thresholds: cfg.thresholds, opencodeRunning: probe.running });
    const { model, limit, compactAt, autoCompact } = contextLimitFor(session, messages);
    const health = deriveHealth({ session, parts, now, thresholds: cfg.thresholds, contextLimit: limit, compactAt, autoCompact });
    const progress = deriveProgress({ parts, messages, todos: db.todos(session.id) });

    return {
      id: session.id,
      parentId: session.parent_id ?? null,
      title: show(session.title, 160),
      project: show(basename(session.directory ?? '') || session.directory, 80),
      directory: show(session.directory, 200),
      model,
      version: session.version ?? null,
      createdAt: session.time_created,
      updatedAt: Math.max(session.time_updated, maxUpdated),
      state: derived.state,
      reason: derived.reason,
      detail: derived.detail ? show(derived.detail, 80) : null,
      since: derived.since,
      limitMs: derived.limitMs ?? null,
      viaChild: null,
      current: derived.current
        ? {
            tool: derived.current.tool,
            summary: show(describePart(derived.current)),
            startedAt: derived.current.started ?? derived.current.time_created,
            output: outputOf(derived.current),
          }
        : null,
      progress: {
        lastActivityAt: progress.lastActivityAt,
        steps: progress.steps.map(step => ({ ...step, text: show(step.text, 100) })),
        todos: progress.todos && { ...progress.todos, current: progress.todos.current ? show(progress.todos.current, 160) : null },
      },
      prompt: derived.prompt
        ? { kind: derived.prompt.kind, permission: derived.prompt.permission, detail: show(derived.prompt.detail) }
        : null,
      health: {
        ...health,
        lastError: health.lastError ? { tool: health.lastError.tool, text: show(health.lastError.text, 200), at: health.lastError.at } : null,
        repeat: health.repeat ? { count: health.repeat.count, tool: health.repeat.tool, text: show(health.repeat.text, 120) } : null,
      },
      work: workOf(session, digest),
      review: reviewOf(digest, asks),
    };
  }

  let previous = { sessions: [], environment: null };
  let directories = [];

  function snapshot(now = Date.now()) {
    const base = { now, opencodeRunning: probe.running, lookbackHours: cfg.lookbackHours };
    try {
      log.poll();
      const rows = db.recentSessions(now - cfg.lookbackHours * 3_600_000, cfg.maxSessions);
      const asks = log.asks();
      directories = [...new Set(rows.map(r => r.directory).filter(Boolean))];
      const sessions = bubbleChildren(rows.map(row => buildSession(row, now, asks)));
      const listed = new Set(rows.map(r => r.id));
      for (const id of cache.keys()) if (!listed.has(id)) cache.delete(id);

      const projectServers = projectMcp?.forDirs(directories) ?? [];
      const serverOf = createServerMatcher([...mcpNames, ...projectServers.map(s => s.name)]);
      previous = { sessions, environment: environment?.view(mcpUseOf(serverOf), projectServers) ?? null };
      return { ...base, stale: false, ...previous };
    } catch (err) {
      // Usually a brief lock while OpenCode writes. Keep showing the last good data, marked stale.
      console.warn(`Poll failed: ${err.code ?? err.message}`);
      return { ...base, stale: true, ...previous };
    }
  }

  /** Project directories of the sessions on screen, for the git probe. */
  snapshot.directories = () => directories;
  /** Background-flagged calls of the sessions on screen, for the leftover-process probe. */
  snapshot.backgroundCalls = () => {
    const calls = [];
    for (const entry of cache.values()) {
      for (const p of entry.digest.flagged) {
        if (p.cmd && p.flags.some(f => f.rule === 'background')) calls.push({ key: p.id, at: p.started ?? p.time_created, cmd: p.cmd });
      }
    }
    return calls;
  };
  return snapshot;
}
