// Polls the data sources and builds the snapshot the page shows.
// Everything that leaves this module has been through the redactor.
import { basename, relative, isAbsolute } from 'node:path';
import { deriveState, deriveHealth, deriveProgress, describePart, bubbleChildren } from './state.mjs';
import { classifyPart, approvalOf, FLAG_KINDS } from './audit.mjs';
import { clip } from './redact.mjs';
import { OUTPUT_TAIL_CHARS } from './db.mjs';

const SUMMARY_CHARS = 240;
const OUTPUT_LINES = 6;
const REVIEW_GROUPS = 40;
const REVIEW_EXAMPLES = 25;
const FILE_TOOLS = new Set(['edit', 'write', 'multiedit', 'apply_patch']);

/**
 * @param {object} deps
 * @param {object} deps.db, deps.log, deps.cfg, deps.probe
 * @param {(text: string) => string} deps.redact
 * @param {Map<string, number>} deps.modelLimits
 * @param {string[]} [deps.mcpNames]   configured MCP server names
 * @param {object} [deps.environment]  from createEnvironment
 * @param {object} [deps.git]          from createGitProbe
 */
export function createMonitor({ db, log, cfg, redact, modelLimits, probe, mcpNames = [], environment = null, git = null }) {
  const cache = new Map(); // session id -> { byId, sorted, maxUpdated, digest }
  const show = (text, max = SUMMARY_CHARS) => clip(redact(String(text ?? '').slice(0, 4000)), max);
  const hasSecret = text => redact(text) !== text;
  const ignoredRules = new Set(cfg.review?.ignoreRules ?? []);
  // Longest first, so "chrome-devtools_click" is not attributed to a server named "chrome".
  const servers = [...mcpNames].sort((a, b) => b.length - a.length);
  const serverOf = tool => servers.find(name => tool.startsWith(name + '_')) ?? null;

  // Last lines a running command has printed, and when the last of them arrived.
  function outputOf(part) {
    if (part.status !== 'running' || !part.out_len) return null;
    let text = part.out_tail ?? '';
    // The tail may start mid-line, and half a secret would slip past the redactor.
    if (part.out_len > OUTPUT_TAIL_CHARS) text = text.slice(text.indexOf('\n') + 1);
    const lines = redact(text).split(/\r?\n/).map(line => line.trimEnd()).filter(Boolean).slice(-OUTPUT_LINES);
    return { lines: lines.map(line => (line.length > 200 ? line.slice(0, 199) + '…' : line)), chars: part.out_len, at: part.time_updated };
  }

  // Per-session facts that only change when parts change: flagged calls, files touched,
  // and the last time each MCP server answered.
  function digestOf(sorted) {
    const flagged = [];
    const files = new Map(); // path -> last touched
    const mcpUse = new Map(); // server -> { okAt }
    for (const p of sorted) {
      if (p.type === 'patch' && p.fileList) {
        for (const file of p.fileList) files.set(file, p.time_created);
      } else if (p.type === 'tool') {
        if (FILE_TOOLS.has(p.tool) && p.status === 'completed' && p.file) files.set(p.file, p.time_updated);
        if (p.flags.length) flagged.push(p);
        const server = p.status === 'completed' ? serverOf(p.tool) : null;
        if (server) mcpUse.set(server, { okAt: p.time_updated });
      }
    }
    return { flagged, files, mcpUse };
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
    const limit = cfg.contextLimit.models[key] ?? cfg.contextLimit.models[model] ?? modelLimits.get(key) ?? cfg.contextLimit.default;
    return { model: model ?? null, limit: limit ?? null };
  }

  const shortPath = (file, root) => {
    const rel = root && isAbsolute(file) ? relative(root, file) : file;
    return show(rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : file, 120).replaceAll('\\', '/');
  };

  // What the agent did to the project: files it touched, and the state of the repository.
  function workOf(session, digest) {
    const recent = [...digest.files].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([file]) => shortPath(file, session.directory));
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
    };
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
    const { model, limit } = contextLimitFor(session, messages);
    const health = deriveHealth({ session, parts, now, thresholds: cfg.thresholds, contextLimit: limit });
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

      const mcpUse = new Map();
      for (const entry of cache.values()) {
        for (const [server, use] of entry.digest.mcpUse) if (!(mcpUse.get(server)?.okAt >= use.okAt)) mcpUse.set(server, use);
      }
      previous = { sessions, environment: environment?.view(mcpUse) ?? null };
      return { ...base, stale: false, ...previous };
    } catch (err) {
      // Usually a brief lock while OpenCode writes. Keep showing the last good data, marked stale.
      console.warn(`Poll failed: ${err.code ?? err.message}`);
      return { ...base, stale: true, ...previous };
    }
  }

  /** Project directories of the sessions on screen, for the git probe. */
  snapshot.directories = () => directories;
  return snapshot;
}
