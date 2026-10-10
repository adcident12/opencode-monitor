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
  /** "project": defined only in a project's own OpenCode config. */
  scope: "global" | "project"
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

/** A session that History or Stats can be narrowed to. */
export interface SessionChoice {
  id: string
  title: string
  project: string
}

/** One side of a before/after comparison: rates and typical values only. */
export interface PeriodSummary {
  days: number
  sessions: number
  startTokens: number | null
  compactionsPerSession: number | null
  rereadsPerSession: number | null
  toolCallsPerSession: number | null
  toolErrorPct: number | null
  mcpNoAnswerPct: number | null
  cachedPct: number | null
  writeTps: number | null
  firstTokenMs: number | null
  medianAnswerMs: number | null
}

/** One MCP server over the stats period. */
export interface McpStat {
  name: string
  type: "local" | "remote"
  enabled: boolean
  scope: "global" | "project"
  calls: number
  /** Calls the tool itself reported as failed. */
  errors: number
  /** Calls where the server did not answer: connection gone or request timed out. */
  faults: number
  avgMs: number | null
  lastUsedAt: number | null
  sessions: number
  /** null while a single session is shown: the log does not say which session it was. */
  disconnects: number | null
  startFailures: number | null
  unused: boolean
  tools: { tool: string; count: number; errors: number; faults: number }[]
  moreTools: number
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
  tokens: number
}

export interface Stats {
  range: { from: number; to: number; days: number }
  session: SessionChoice | null
  sessions: (SessionChoice & { toolCalls: number; lastAt: number })[]
  mcp: McpStat[]
  /** Oldest line of OpenCode's log that was read; failures before it are unknown. */
  mcpLogFrom: number | null
  /** Present when a day to split the period on was asked for and both sides have days. */
  compare: { split: string; model: string | null; before: PeriodSummary; after: PeriodSummary } | null
  /** How fast each model answered, most used first. Rates are tokens per second. */
  speed: {
    models: { model: string; requests: number; writeTps: number | null; readTps: number | null; firstTokenMs: number | null; daily: (number | null)[] }[]
  }
  /** Tokens as the model server reported them, per request, summed over the period. */
  usage: {
    requests: number
    input: number
    cacheRead: number
    cacheWrite: number
    output: number
    reasoning: number
    cost: number
    cachedPct: number | null
    /** Size of the first request of each session that began in the period. */
    start: { median: number; min: number; max: number; sessions: number } | null
  }
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
