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
    /** Where OpenCode will compact, and how far off that is. null when the model's limits are unknown. */
    compaction: { at: number; room: number; growth: number | null; requestsLeft: number | null } | null
    /** Compacted, and no ordinary request since: the size of the new context is not known yet. */
    compacting: boolean
    /** Compactions forced by the model server refusing a request as too long. */
    overflowCompactions: number
    /** false when compaction.auto is off in OpenCode's config: it will not compact by itself. */
    autoCompact: boolean
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
  /** Version of the monitor that is running, from its package.json. */
  version: string | null
  /** Version of the OpenCode that wrote the newest session. */
  opencodeVersion: string | null
  /** The OpenCode release this monitor was checked against. */
  opencodeTested: string | null
  /** OpenCode is a later minor or major release than that: figures may be off. */
  opencodeUntested: boolean
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
  costPerSession: number | null
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

/** What the monitor found on this machine (src/setup.mjs). No secret is ever in it. */
export interface SetupReport {
  monitor: { version: string | null; port: number; lang: string; configFile: { path: string; found: boolean } | null; platform: string }
  opencode: {
    dataDir: string
    database: { path: string; found: boolean; bytes: number | null }
    log: { path: string; found: boolean; bytes: number | null }
    configDir: string
    configFiles: string[]
    version: string | null
    tested: string
    running: boolean | null
  }
  compaction: { auto: boolean; reserved: number | null; outputTokenMax: number | null }
  models: { id: string; requests: number; lastAt: number; context: number | null; output: number | null; input: number | null; source: "opencode" | "monitor" | null; compactAt: number | null }[]
  mcp: { name: string; type: "local" | "remote"; enabled: boolean }[]
  notify: {
    /** The week's takeaways, to Discord only. weekday: 0 Sunday .. 6 Saturday. */
    weekly: { enabled: boolean; weekday: number; hour: number }
    desktop: boolean
    discord: boolean
    on: string[]
    repeatMinutes: number
    /** What was sent since the monitor started, newest first. Each channel: "sent", "off", "sending" or "failed (...)". */
    recent: { t: number; kind: string; title: string; subject: string; desktop: string; discord: string }[]
  }
  history: { enabled: boolean; file: string; retentionDays: number; count: number | null }
  problems: { code: string; subject: string | null }[]
}

/** A page of history, newest first; more: matching entries older than it. */
export interface HistoryPage {
  events: HistoryEvent[]
  more: number
  /** The record outgrew what the monitor keeps in memory; older entries are only in the file. */
  truncated: boolean
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
  /** As OpenCode recorded it; 0 for a model that costs nothing. */
  cost: number
  readingMs: number
  thinkingMs: number
  writingMs: number
  toolMs: number
  files: number
}

/** A rule over the figures below it; the page writes the sentence from `id` and `vars`. */
export interface Takeaway {
  id: string
  tone: "act" | "note"
  vars: Record<string, string | number>
  /** The chapter with the details. */
  anchor: string
}

export interface Stats {
  range: { from: number; to: number; days: number }
  session: SessionChoice | null
  /** Top-level sessions in the range with what each cost, whatever session is selected. */
  sessions: (SessionChoice & { toolCalls: number; lastAt: number; activeMs: number; waitMs: number; compactions: number; tokens: number; cost: number })[]
  mcp: McpStat[]
  /** Oldest line of OpenCode's log that was read; failures before it are unknown. */
  mcpLogFrom: number | null
  /** Present when a day to split the period on was asked for and both sides have days. */
  compare: { split: string; model: string | null; before: PeriodSummary; after: PeriodSummary } | null
  /** At most five rules that held, most useful first; empty when the evidence is too thin. */
  takeaways: Takeaway[]
  /** Only with one session selected: how its context filled and where it was compacted. */
  context: {
    limit: number | null
    /** Where OpenCode compacts this session, by its own rule. null: unknown, or switched off. */
    compactAt: number | null
    peak: number
    requests: number
    points: { t: number; tokens: number }[]
    /** at: index into points of the first request after the compaction. */
    compactions: { t: number; at: number | null; before: number | null; after: number | null; reread: number }[]
    rereadAfterCompaction: number
  } | null
  /** Everything about the period that is not one tool call (src/work.mjs). */
  work: {
    time: { readingMs: number; thinkingMs: number; writingMs: number; toolMs: number }
    turns: {
      count: number
      ended: { done: number; continued: number; cut: number; aborted: number; error: number; unanswered: number; open: number }
      medianSteps: number | null
      medianMs: number | null
      longestMs: number | null
      cut: { at: number; model: string | null; project: string; title: string }[]
    }
    permissions: { asked: number; top: { permission: string; pattern: string; count: number; waitMs: number; lastAt: number }[] }
    files: { edits: number; files: number; top: { file: string; count: number; project: string; title: string }[] }
    agents: { agent: string; requests: number; activeMs: number; tokens: number; cost: number; subagent: boolean }[]
    /** Rebuilt from every task list the agent wrote; "dropped" left a list without being done. */
    plans: {
      sessions: number
      total: number
      completed: number
      inProgress: number
      pending: number
      cancelled: number
      dropped: number
      rewrites: number
      unfinished: { id: string; total: number; completed: number; inProgress: number; pending: number; cancelled: number; dropped: number; rewrites: number; project: string; title: string }[]
    }
  }
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
    serverLimitCompactions: number
  }
  waits: { at: number; kind: "permission" | "question"; permission: string | null; detail: string; waitMs: number; answered: boolean; abandoned: boolean; project: string; title: string }[]
  slow: { at: number; tool: string; text: string; runMs: number; status: string; running: boolean; project: string; title: string }[]
  tools: { tool: string; count: number; errors: number; totalMs: number }[]
  explore: { graft: number; other: number }
  rereads: { file: string; count: number; project: string; title: string }[]
  skills: { name: string; count: number }[]
}

/** One save of an OpenCode config file that changed a setting. */
export interface ConfigChange {
  t: number
  /** Shown from the home directory. */
  file: string
  /** The global config, not a project's. */
  global: boolean
  /** `hidden`: the value is not kept (an address, a command), only that it changed. */
  changes: { path: string; kind: "added" | "removed" | "changed"; from?: string | number | boolean | null; to?: string | number | boolean | null; hidden?: true }[]
  /** Changes beyond those listed. */
  more: number
}
