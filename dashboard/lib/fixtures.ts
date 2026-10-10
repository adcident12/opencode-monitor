// A session as the server sends it, for tests. Each test changes what it is about.
import type { Session } from "./types"

export const NOW = 1_800_000_000_000

export const waiting: Session = {
  id: "s1", parentId: null, title: "Wire up the staging environment", project: "clinic-app", directory: "/work/clinic-app",
  model: null, createdAt: NOW - 11 * 3_600_000, updatedAt: NOW, state: "waiting", reason: "permission", detail: null,
  since: NOW - (8 * 3600 + 10 * 60 + 42) * 1000, limitMs: null, current: null,
  prompt: { kind: "permission", permission: "read", detail: "/work/clinic-app/.env" },
  progress: { lastActivityAt: NOW - 8 * 3_600_000, steps: [], todos: null },
  health: { contextTokens: 54_000, contextLimit: 131_072, contextPct: 41, compaction: { at: 99_072, room: 44_000, growth: 5500, requestsLeft: 8 }, compacting: false, overflowCompactions: 0, autoCompact: true, compactions: 0, toolCalls: 9, toolErrors: 0, lastError: null, repeat: null, hints: ["old_session"], suggestNewSession: true },
  work: { files: { count: 0, recent: [] }, git: { branch: "main", detached: false, state: "ok" }, warnProtected: true, warnUnknownBranch: false, running: { failed: false, items: [{ pid: 4242, pids: [4242, 4243], name: "cmd.exe", command: "cmd /c npm run dev", startedAt: NOW - 600_000, ports: [3000], processes: 2, from: "Start-Process npm -ArgumentList run,dev" }] } },
  review: {
    counts: { risky: 0, secret_value: 0, secret_file: 1, outbound: 0, background: 0 }, total: 1, more: 0, ignored: 0,
    items: [{ kind: "secret_file", rule: "secret_file", host: null, at: NOW, count: 1, approvals: { asked: 1, rule: 0, refused: 0 }, hiddenExamples: 0,
      examples: [{ tool: "read", text: "/work/clinic-app/.env", at: NOW, count: 1, approvals: { asked: 1, rule: 0, refused: 0 } }] }],
  },
}
