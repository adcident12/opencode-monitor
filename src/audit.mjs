// Pure rules that flag tool calls worth a second look: destructive commands, processes left
// in the background, things sent off the machine, and secrets touched. Pattern-based, so it
// points at candidates; it does not prove anything happened or that anything was missed.

export const FLAG_KINDS = ['risky', 'secret_value', 'secret_file', 'outbound', 'background'];

const LOCAL_HOST = /^(?:localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[?::1\]?|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|host\.docker\.internal|[\w-]+\.local|[\w-]+)$/i;

/** Loopback, private ranges, and bare hostnames count as "on this machine or network". */
export function isLocalHost(host) {
  return LOCAL_HOST.test(String(host ?? '').replace(/:\d+$/, ''));
}

// One command segment: stops at | ; & or a newline.
const SEG = String.raw`[^|;&\n]*`;

const RISKY = [
  ['delete_recursive', new RegExp(String.raw`\brm\s+(?:-\w+\s+)*-\w*[rR]\w*\b|\bRemove-Item\b${SEG}-Recurse|\b(?:rmdir|rd)\s+/s\b|\bdel\s+/s\b|\brimraf\b`, 'i')],
  ['kill_process', /\b(?:Stop-Process|taskkill|pkill|killall)\b|\bkill\s+-(?:9|KILL)\b/i],
  ['git_force_push', new RegExp(String.raw`\bgit\b${SEG}\bpush\b${SEG}(?:--force\b|--force-with-lease|\s-f\b)`)],
  ['git_discard', new RegExp(String.raw`\bgit\b${SEG}\b(?:reset\s+--hard|clean\s+-\w*f|checkout\s+(?:--\s+)?\.(?:\s|$)|restore\s+\.(?:\s|$)|branch\s+-D\b|stash\s+(?:drop|clear))`)],
  ['db_destructive', /\b(?:drop\s+(?:table|database|schema)|truncate\s+table)\b|\bdelete\s+from\s+[\w."`]+\s*(?:;|"|'|$)|\bmigrate\s+reset\b|--force-reset\b/i],
  ['docker_destructive', new RegExp(String.raw`\bdocker\b${SEG}\b(?:system|volume|image|container|builder)\s+prune\b|\bdocker\s+volume\s+rm\b|\bcompose\b${SEG}\bdown\b${SEG}(?:\s-v\b|--volumes)`)],
  ['pipe_to_shell', /\b(?:curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^\n]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|iex|Invoke-Expression)\b/i],
  ['elevated', /\bsudo\s|-Verb\s+RunAs\b/i],
  ['open_permissions', /\bchmod\s+(?:-R\s+)?(?:777|a\+rwx)\b/],
  ['disk', /\bmkfs(?:\.\w+)?\b|\bdd\s+if=|\bFormat-Volume\b|\bdiskpart\b/i],
];

const BACKGROUND = /\bStart-Process\b|\bStart-Job\b|\bnohup\s|\bstart\s+\/b\b|[^&|]&\s*$|\bup\s+(?:-[\w-]+\s+)*(?:-d|--detach)\b/im;

const OUTBOUND = [
  ['git_push', new RegExp(String.raw`\bgit\b${SEG}\bpush\b`)],
  ['publish', /\b(?:npm|pnpm|yarn|cargo)\s+publish\b|\bdocker\s+push\b|\bgh\s+(?:release|pr|issue|gist)\s+create\b|\btwine\s+upload\b/],
  ['remote_shell', new RegExp(String.raw`\b(?:ssh|scp|sftp|rsync)\s${SEG}[\w.-]+@[\w.-]+`)],
];
const HTTP_CLIENT = /\b(?:curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b/i;
const URL_HOST = /\bhttps?:\/\/(?:[^\s/@"']*@)?(\[[^\]\s]+\]|[^\s/:"'?#]+)/gi;

const SECRET_FILE = /(?:^|[\\/\s"'=(])(?:\.env(?:\.(?!example\b|sample\b|template\b|dist\b|defaults\b)[\w-]+)*|id_(?:rsa|ed25519|ecdsa|dsa)|[\w.-]+\.(?:pem|pfx|p12|key|keystore|jks)|\.npmrc|\.netrc|\.pgpass|\.git-credentials|credentials(?:\.json)?|secrets?\.(?:json|ya?ml|toml|env)|auth\.json|\.aws[\\/]\w+|\.kube[\\/]config)(?=$|[\s"';|)&,])/i;

function externalHost(text) {
  for (const m of String(text ?? '').matchAll(URL_HOST)) if (!isLocalHost(m[1])) return m[1].toLowerCase();
  return null;
}

/**
 * @param {object} part  a tool part row (cmd, file, url, tool, scan_out)
 * @param {(text: string) => boolean} hasSecret
 * @returns {{kind: string, rule: string, host?: string}[]}
 */
export function classifyPart(part, hasSecret = () => false) {
  const flags = [];
  const add = (kind, rule, extra) => flags.push({ kind, rule, ...extra });

  if (part.tool === 'bash' && part.cmd) {
    const cmd = part.cmd;
    for (const [rule, pattern] of RISKY) if (pattern.test(cmd)) add('risky', rule);
    if (BACKGROUND.test(cmd)) add('background', 'background');
    for (const [rule, pattern] of OUTBOUND) if (pattern.test(cmd)) add('outbound', rule);
    const host = HTTP_CLIENT.test(cmd) ? externalHost(cmd) : null;
    if (host) add('outbound', 'http_request', { host });
    if (SECRET_FILE.test(cmd)) add('secret_file', 'secret_file');
  } else if (part.tool === 'read' && part.file && SECRET_FILE.test(part.file)) {
    add('secret_file', 'secret_file');
  } else if (part.tool === 'webfetch') {
    const host = externalHost(part.url ?? part.input);
    if (host) add('outbound', 'http_request', { host });
  }

  if (hasSecret(part.cmd ?? part.input ?? '')) add('secret_value', 'in_command');
  if (part.scan_out && hasSecret(part.scan_out)) add('secret_value', 'in_output');
  return flags;
}

const ASK_MATCH_MS = 2000;

/**
 * Who let a tool call run. OpenCode logs when it asks; a call that was asked about and
 * then ran was approved by the user, one that ran without a prompt was allowed by a rule.
 * @returns {'you'|'rule'|'denied'}
 */
export function approvalOf(part, asks) {
  if (part.status === 'error' && /rejected permission/i.test(part.error ?? '')) return 'denied';
  const at = part.started ?? part.time_created;
  for (let i = asks.length - 1; i >= 0; i--) {
    const ask = asks[i];
    if (ask.t < at - ASK_MATCH_MS) break;
    if (ask.kind === 'permission' && Math.abs(ask.t - at) <= ASK_MATCH_MS) return 'you';
  }
  return 'rule';
}
