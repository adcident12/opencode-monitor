// Pure rules that flag tool calls worth a second look: destructive commands, processes left
// in the background, things sent off the machine, and secrets touched.
//
// This is a hint list, not a security control. It matches text; it does not parse or run
// the shell, so a command can always be written in a way these patterns do not see
// (variables, substitutions, scripts on disk, another interpreter). Nothing may rely on an
// empty result to mean "nothing risky happened". What blocks commands is OpenCode's own
// permission system; this only helps a person decide where to look afterwards.

export const FLAG_KINDS = ['risky', 'secret_value', 'secret_file', 'outbound', 'background'];

const LOCAL_HOST = /^(?:localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[?::1\]?|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|host\.docker\.internal|[\w-]+\.local|[\w-]+)$/i;

/** Loopback, private ranges, and bare hostnames count as "on this machine or network". */
export function isLocalHost(host) {
  return LOCAL_HOST.test(String(host ?? '').replace(/:\d+$/, ''));
}

// One command segment: stops at | ; & or a newline.
const SEG = String.raw`[^|;&\n]*`;

const RISKY = [
  ['delete_recursive', new RegExp(
    String.raw`\brm\s+(?:-[\w-]+\s+)*(?:-\w*[rR]\w*|--recursive)\b` +
    // PowerShell: Remove-Item and its aliases, with -Recurse abbreviated any way PowerShell accepts
    String.raw`|\b(?:Remove-Item|ri|rm|del|erase|rmdir|rd)\b${SEG}\s-r(?:e(?:c(?:u(?:r(?:s(?:e)?)?)?)?)?)?\b` +
    String.raw`|\b(?:rmdir|rd|del|erase)\s+(?:/\w\s+)*/s\b|\brimraf\b|\bfind\b${SEG}(?:\s-delete\b|-exec\s+rm\b)|\brmtree\b|\brmSync\b`, 'i')],
  ['kill_process', /\b(?:Stop-Process|spps|taskkill|pkill|killall)\b|\bkill\s+-(?:9|KILL|s\s+(?:9|KILL))\b|\|\s*kill\b|\bwmic\s+process\b[^|;&\n]*\bdelete\b/i],
  // --force/-f, --mirror, deleting a remote branch, or a +refspec, which forces without any flag
  ['git_force_push', new RegExp(String.raw`\bgit\b${SEG}\bpush\b${SEG}(?:--force\b|--force-with-lease|\s-\w*f\w*\b|--mirror\b|--delete\b|\s-d\b|\s\+[\w./-]+|\s:[\w./-]+)`)],
  ['git_discard', new RegExp(String.raw`\bgit\b${SEG}\b(?:reset\s+--hard|clean\s+-\w*f|checkout\s+(?:--\s+)?\.(?:\s|$)|restore\s+\.(?:\s|$)|branch\s+-D\b|stash\s+(?:drop|clear))`)],
  // Rewriting git's own records, or the programs git runs for the user later.
  ['git_internals', new RegExp(String.raw`\breflog\s+(?:expire|delete)\b|logAllRefUpdates|\.git[\\/](?:logs|hooks|config|HEAD|packed-refs|refs)\b|\bgit\b${SEG}\bconfig\b${SEG}(?:core\.(?:fsmonitor|hooksPath|sshCommand|pager|editor)|filter\.|gpg\.program|alias\.|credential\.)|\bgit\b${SEG}\b(?:filter-branch|filter-repo|update-ref|gc\s${SEG}--prune)`, 'i')],
  ['db_destructive', /\b(?:drop\s+(?:table|database|schema)|truncate\s+table)\b|\bdelete\s+from\s+[\w."`]+\s*(?:;|"|'|$)|\bmigrate\s+reset\b|--force-reset\b/i],
  ['docker_destructive', new RegExp(String.raw`\bdocker\b${SEG}\b(?:system|volume|image|container|builder)\s+prune\b|\bdocker\s+volume\s+rm\b|\bcompose\b${SEG}\bdown\b${SEG}(?:\s-v\b|--volumes)`)],
  ['pipe_to_shell', /\b(?:curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^\n]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|iex|Invoke-Expression)\b/i],
  ['elevated', /\bsudo\s|-Verb\s+RunAs\b/i],
  ['open_permissions', /\bchmod\s+(?:-R\s+)?(?:777|a\+rwx)\b/],
  ['disk', /\bmkfs(?:\.\w+)?\b|\bdd\s+if=|\bFormat-Volume\b|\bdiskpart\b/i],
];

// A command built at run time cannot be judged by reading it. Say so instead of staying quiet.
const HIDDEN = /\beval\s|\b(?:iex|Invoke-Expression)\b|-(?:EncodedCommand|enc|ec)\s+[A-Za-z0-9+/=]{16,}|\bbase64\s+(?:-d|--decode)\b|\bFromBase64String\b|\b(?:sh|bash|zsh|pwsh|powershell|cmd)(?:\.exe)?\s+(?:-\w+\s+)*(?:-c|\/c|-Command)\s+["']?\$\(|\|\s*(?:sh|bash|zsh)\b|\bxargs\s+(?:-\S+\s+)*(?:sh|bash|rm)\b|\$\{?IFS\b/i;
// A variable in command position ($RM -rf x, & $tool args): the program run is not in the text.
const VARIABLE_COMMAND = /(?:^|[;&|\n]\s*|&\s+)\$\{?[A-Za-z_]\w*\}?[ \t]+[-\w"'./~]/m;

// The shell joins continued lines and drops quotes, carets and backslash escapes before
// running a word, so r"m" -rf, 'rm' -rf and r\m -rf are all rm -rf. Rules are tried on
// this form as well as on the text as written.
const unquote = cmd => cmd.replace(/[\\`^]\r?\n\s*/g, '').replace(/["'`^]|\\(?=[A-Za-z-])/g, '');

const BACKGROUND =/\bStart-Process\b|\bStart-Job\b|\bnohup\s|\bstart\s+\/b\b|[^&|]&\s*$|\bup\s+(?:-[\w-]+\s+)*(?:-d|--detach)\b/im;

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
    const plain = unquote(cmd);
    const matches = pattern => pattern.test(cmd) || pattern.test(plain);
    for (const [rule, pattern] of RISKY) if (matches(pattern)) add('risky', rule);
    if ((HIDDEN.test(cmd) || VARIABLE_COMMAND.test(cmd)) && !flags.some(f => f.rule === 'pipe_to_shell')) add('risky', 'hidden_command');
    if (BACKGROUND.test(cmd)) add('background', 'background');
    for (const [rule, pattern] of OUTBOUND) if (matches(pattern)) add('outbound', rule);
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
// The exact text OpenCode stores when the user says no. Matched from the start, so a
// command cannot earn the "refused" label by printing similar words.
const REJECTED = 'The user rejected permission';
// Which prompt kinds can belong to which tool. A prompt of another kind logged at the same
// moment (another session, another tool) must not be read as approval of this call.
const PROMPT_KINDS = { bash: ['bash'], read: ['read'], edit: ['edit'], write: ['edit'], webfetch: ['webfetch'] };

function promptFits(ask, tool) {
  if (!ask.permission || ask.permission === 'external_directory') return true;
  return (PROMPT_KINDS[tool] ?? [tool]).includes(ask.permission);
}

/**
 * Whether a prompt was shown for a tool call. OpenCode logs when it asks but not the answer,
 * so this is an inference from timing, not a record:
 *   refused - OpenCode stored its own "rejected permission" error for the call
 *   asked   - a fitting prompt was logged as the call started, and the call went on to run
 *   rule    - no prompt was logged: a permission rule let it through
 * @returns {'asked'|'rule'|'refused'}
 */
export function approvalOf(part, asks) {
  if (part.status === 'error' && String(part.error ?? '').startsWith(REJECTED)) return 'refused';
  const at = part.started ?? part.time_created;
  for (let i = asks.length - 1; i >= 0; i--) {
    const ask = asks[i];
    if (ask.t < at - ASK_MATCH_MS) break;
    if (ask.kind === 'permission' && Math.abs(ask.t - at) <= ASK_MATCH_MS && promptFits(ask, part.tool)) return 'asked';
  }
  return 'rule';
}
