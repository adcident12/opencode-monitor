// Hides secret-looking values before anything is shown, logged, or sent anywhere.
// Errs on the side of hiding too much.

const MASK = '[redacted]';

const SECRET_NAME = String.raw`(?:token|secret|passw(?:or)?d|passwd|pwd|pass(?![a-z])|api[_-]?key|access[_-]?key|private[_-]?key|credential|authorization)`;

// Values that are clearly not secrets even under a secret-sounding name (max_tokens=4096).
const HARMLESS_VALUE = /^["']?(?:true|false|null|undefined|\d{1,6})["']?$/i;

const RULES = [
  // PEM private keys
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, MASK],
  // Discord webhook URLs carry their token in the path
  [/https:\/\/(?:[\w-]+\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+/g, MASK],
  // scheme://user:password@host
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+):([^\s@/]+)@/gi, `$1:${MASK}@`],
  // Tokens with a recognisable prefix: SonarQube, GitHub, GitLab, OpenAI-style, Slack, AWS, Google, JWT
  [/\b(?:sq[upa]_[0-9a-f]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|glpat-[\w-]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[\w-]{35}|eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{5,})/g, MASK],
  // Authorization header values
  [/\b(Bearer|Basic)\s+[a-z0-9._~+/=-]{8,}/gi, `$1 ${MASK}`],
  // --password value, --token=value
  // (name parts are length-capped so long unbroken output cannot make these patterns slow)
  [new RegExp(String.raw`(--?[\w-]{0,40}${SECRET_NAME}[\w-]{0,40}(?:\s+|=))("[^"]*"|'[^']*'|\S+)`, 'gi'), keepHarmless],
  // NAME=value, "name": "value", $env:NAME = 'value'
  [new RegExp(String.raw`(["']?[\w.-]{0,40}${SECRET_NAME}[\w.-]{0,40}["']?\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s"',;&|)}]+)`, 'gi'), keepHarmless],
];

function keepHarmless(match, prefix, value) {
  return HARMLESS_VALUE.test(value) || value.includes(MASK) ? match : prefix + MASK;
}

export function createRedactor({ enabled = true, extraPatterns = [] } = {}) {
  if (!enabled) return text => (text == null ? '' : String(text));
  const rules = [...RULES];
  for (const source of extraPatterns) rules.push([new RegExp(source, 'g'), MASK]);
  return text => {
    if (text == null) return '';
    let out = String(text);
    for (const [pattern, replacement] of rules) out = out.replace(pattern, replacement);
    return out;
  };
}

// Redact first, then shorten: cutting first could split a secret so no rule matches it.
export function clip(text, max) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
}
