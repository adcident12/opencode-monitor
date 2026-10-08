// Shape of what the monitor server sends (src/monitor.mjs). Everything in here has already
// been through the server's redactor.

export type State = "waiting" | "stuck" | "error" | "working" | "finished" | "idle"
export type Approval = "asked" | "rule" | "refused"
export type FlagKind = "risky" | "secret_value" | "secret_file" | "outbound" | "background"

export interface Step {
  tool: string
  text: string
  status: "pending" | "running" | "completed" | "error"
  startedAt: number
  durationMs: number | null
}

export interface ReviewExample {
  tool: string
  text: string
  at: number
  count: number
  approvals: Record<Approval, number>
}

export interface ReviewItem {
  kind: FlagKind
  rule: string
  host: string | null
  at: number
  count: number
  approvals: Record<Approval, number>
  examples: ReviewExample[]
  hiddenExamples: number
}

export interface Session {
  id: string
  parentId: string | null
  title: string
  project: string
  directory: string
  model: string | null
  createdAt: number
  updatedAt: number
  state: State
  reason: string
  detail: string | null
  since: number
  limitMs: number | null
  current: {
    tool: string
    summary: string
    startedAt: number
    output: { lines: string[]; chars: number; at: number } | null
  } | null
  prompt: { kind: "permission" | "question"; permission: string | null; detail: string } | null
  progress: {
    lastActivityAt: number | null
    steps: Step[]
    todos: { done: number; total: number; current: string | null } | null
  }
  health: {
    contextTokens: number | null
    contextLimit: number | null
    contextPct: number | null
    compactions: number
    toolCalls: number
    toolErrors: number
    lastError: { tool: string; text: string; at: number } | null
    repeat: { count: number; tool: string; text: string } | null
    hints: string[]
    suggestNewSession: boolean
  }
  work: {
    files: { count: number; recent: string[] }
    git: { branch: string | null; detached: boolean; state: "ok" | "unreadable" | "pending" } | null
    warnProtected: boolean
    warnUnknownBranch: boolean
    running: {
      failed: boolean
      items: { pid: number; pids: number[]; name: string; command: string; startedAt: number; ports: number[]; processes: number; from: string }[]
    } | null
  }
  review: {
    counts: Record<FlagKind, number>
    total: number
    items: ReviewItem[]
    more: number
    ignored: number
  }
}

export interface CheckedTarget {
  name: string
  target: string
  ok: boolean | null
  status?: number | null
  ms?: number | null
  error?: "unreachable" | "timeout" | null
}

export interface McpServer {
  name: string
  type: "local" | "remote"
  status: "ok" | "failed" | "unknown" | "disabled"
  kind: "unavailable" | "closed" | null
  failedAt: number | null
  lastOkAt: number | null
}

export interface Snapshot {
  now: number
  opencodeRunning: boolean | null
  stale: boolean
  lookbackHours: number
  sessions: Session[]
  environment: { checkedAt: number | null; models: CheckedTarget[]; services: CheckedTarget[]; mcp: McpServer[] } | null
  historyCount: number | null
  build: string | null
}

export interface HistoryEvent {
  t: number
  since: number
  id: string
  title: string
  project: string
  from: State | null
  fromMs: number | null
  to: State
  reason: string
  permission: string | null
  limitMs: number | null
  error: string | null
  detail: string | null
}

export interface DayStats {
  date: string
  activeMs: number
  waitMs: number
  prompts: number
  stuck: number
  abandoned: number
  toolCalls: number
  toolErrors: number
  compactions: number
  sessions: number
}

export interface Stats {
  range: { from: number; to: number; days: number }
  stuckMs: number
  daily: DayStats[]
  totals: {
    sessions: number
    activeMs: number
    waitMs: number
    prompts: number
    open: number
    abandoned: number
    medianAnswerMs: number | null
    stuck: number
    abandonedCalls: number
    toolCalls: number
    toolErrors: number
    compactions: number
  }
  waits: { at: number; kind: "permission" | "question"; permission: string | null; detail: string; waitMs: number; answered: boolean; abandoned: boolean; project: string; title: string }[]
  slow: { at: number; tool: string; text: string; runMs: number; status: string; running: boolean; project: string; title: string }[]
  tools: { tool: string; count: number; errors: number; totalMs: number }[]
  explore: { graft: number; other: number }
  rereads: { file: string; count: number; project: string; title: string }[]
  skills: { name: string; count: number }[]
}
