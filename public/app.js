// Renders snapshots pushed by the server. All text goes in through textContent.

const RANK = { waiting: 0, stuck: 1, error: 2, working: 3, finished: 4, idle: 5 };
const NEEDS_YOU = new Set(['waiting', 'stuck', 'error']);
const LANGS = ['en', 'th'];

let strings = {};
let fallback = {};
let snapshot = null;
let clockSkew = 0; // browser clock minus server clock
let connected = false;

const $ = id => document.getElementById(id);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function t(key, vars = {}) {
  return (strings[key] ?? fallback[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => vars[name] ?? '');
}

function duration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

const roughDuration = ms => (ms < 3_600_000 ? `${Math.round(ms / 60_000)}m` : duration(ms));
const serverNow = () => Date.now() - clockSkew;

// A span whose text is re-computed every second from a timestamp.
function ticking(className, key, since) {
  const node = el('span', className);
  node.dataset.since = since;
  node.dataset.key = key;
  return node;
}

function refreshClocks() {
  const now = serverNow();
  for (const node of document.querySelectorAll('[data-since]')) {
    const text = duration(now - Number(node.dataset.since));
    node.textContent = node.dataset.key ? t(node.dataset.key, { t: text }) : text;
  }
}

function reasonText(s) {
  return t(`reason.${s.reason}`, {
    permission: s.prompt?.permission ?? '',
    limit: s.limitMs ? roughDuration(s.limitMs) : '',
    detail: s.detail ?? '',
  });
}

function healthRow(s) {
  const h = s.health;
  const list = el('dl', 'health');
  const item = (label, value, warn) => {
    const row = el('div', warn ? 'warn' : '');
    row.append(el('dt', '', label));
    const dd = el('dd');
    dd.append(value);
    row.append(dd);
    list.append(row);
    return row;
  };

  if (s.state !== 'finished' && s.state !== 'idle' && s.progress.lastActivityAt) {
    item(t('progress.lastActivity'), ticking('', 'time.ago', s.progress.lastActivityAt));
  }
  if (h.contextTokens != null) {
    const k = n => `${Math.round(n / 1000)}k`;
    if (h.contextPct != null) {
      const row = item(t('health.context'), `${k(h.contextTokens)} / ${k(h.contextLimit)} · ${h.contextPct}%`, h.hints.includes('context_high'));
      const meter = el('span', 'meter');
      const fill = el('span');
      fill.style.width = `${Math.min(100, h.contextPct)}%`;
      meter.append(fill);
      row.insertBefore(meter, row.lastChild);
    } else {
      item(t('health.context'), t('health.contextUnknown', { n: k(h.contextTokens) }));
    }
  }
  if (h.compactions) item(t('health.compactions'), String(h.compactions), h.hints.includes('many_compactions'));
  item(t('health.age'), ticking('', '', s.createdAt), h.hints.includes('old_session'));
  if (h.toolErrors) item(t('health.toolErrors'), `${h.toolErrors} / ${h.toolCalls}`, h.hints.includes('many_errors'));
  return list;
}

function hintList(s) {
  const h = s.health;
  if (!h.hints.length) return null;
  const list = el('ul', 'hints');
  const text = {
    context_high: () => t('hint.context_high', { pct: h.contextPct }),
    many_compactions: () => t('hint.many_compactions', { n: h.compactions }),
    old_session: () => t('hint.old_session', { t: roughDuration(serverNow() - s.createdAt) }),
    looping: () => t('hint.looping', { tool: h.repeat.tool, n: h.repeat.count, text: h.repeat.text }),
    many_errors: () => t('hint.many_errors', { n: h.toolErrors }),
  };
  for (const hint of h.hints) list.append(el('li', '', text[hint]?.() ?? hint));
  if (h.suggestNewSession) list.append(el('li', 'advice', t('hint.new_session')));
  return list;
}

function box(className, label, body, since) {
  const node = el('div', `box ${className}`);
  const head = el('div', 'box-label');
  head.append(el('span', '', label));
  if (since) head.append(ticking('', 'time.running', since));
  node.append(head, el('code', '', body));
  return node;
}

// What the running command has printed so far, and how long ago its last line arrived.
// A command that is "running" but has printed nothing new for a long time is the usual hang.
function outputBlock(current) {
  const wrap = el('div', 'output');
  const head = el('div', 'box-label');
  if (current.output) {
    head.append(el('span', '', t('output.last')), ticking('', 'time.ago', current.output.at));
    wrap.append(head, el('pre', '', current.output.lines.join('\n')));
  } else {
    head.append(el('span', '', t('output.none')));
    wrap.append(head);
  }
  return wrap;
}

const STEP_MARK = { completed: '✓', error: '✕', running: '●', pending: '●' };

function progressBlock(s) {
  const p = s.progress;
  const wrap = el('div', 'progress');

  if (p.todos) {
    const row = el('div', 'todos');
    row.append(el('span', 'todos-count', t('progress.todos', { done: p.todos.done, total: p.todos.total })));
    if (p.todos.current) row.append(el('span', '', p.todos.current));
    wrap.append(row);
  }

  // A lone running step is already shown in the box above.
  if (p.steps.length > 1 || (p.steps.length === 1 && p.steps[0].status !== 'running')) {
    wrap.append(el('div', 'box-label', t('progress.steps')));
    const list = el('ol', 'steps');
    for (const step of p.steps) {
      const live = step.status === 'running' || step.status === 'pending';
      const item = el('li', `step-${step.status}`);
      item.append(el('span', 'step-mark', STEP_MARK[step.status] ?? '·'), el('span', 'step-tool', step.tool), el('span', 'step-text', step.text));
      item.append(live ? ticking('step-time', '', step.startedAt) : el('span', 'step-time', step.durationMs == null ? '' : duration(step.durationMs)));
      list.append(item);
    }
    wrap.append(list);
  }
  return wrap.childNodes.length ? wrap : null;
}

// <details> that stays open across the re-render every poll.
const openSections = new Set();
function section(key, className, summaryNodes, body) {
  const node = el('details', `more ${className}`);
  node.open = openSections.has(key);
  node.addEventListener('toggle', () => (node.open ? openSections.add(key) : openSections.delete(key)));
  const summary = el('summary');
  summary.append(...summaryNodes);
  node.append(summary, body);
  return node;
}

// What the agent did to the project: branch, files touched, commits.
function workSection(s) {
  const { files, git, warnProtected } = s.work;
  if (!files.count && !git) return null;
  const parts = [];
  if (git?.branch) parts.push(el('span', warnProtected ? 'tag warn' : 'tag', t('work.branch', { branch: git.branch })));
  if (files.count) parts.push(el('span', '', t('work.files', { n: files.count })));
  if (git?.commitCount) parts.push(el('span', '', t('work.commits', { n: git.commitCount })));
  if (!parts.length) return null;

  const body = el('div', 'more-body');
  if (warnProtected) body.append(el('p', 'warn-text', t('work.protected', { branch: git.branch })));
  if (files.recent.length) {
    body.append(el('div', 'box-label', t('work.recentFiles')));
    const list = el('ul', 'plain mono');
    for (const file of files.recent) list.append(el('li', '', file));
    body.append(list);
  }
  if (git?.commits.length) {
    body.append(el('div', 'box-label', t('work.commitsSince')));
    const list = el('ul', 'plain');
    for (const commit of git.commits) {
      const item = el('li');
      item.append(el('code', '', commit.hash), ` ${commit.subject}`);
      list.append(item);
    }
    body.append(list);
  }
  return section(`${s.id}:work`, 'work', [el('span', 'more-title', t('work.title')), ...parts], body);
}

const KIND_ORDER = ['risky', 'secret_value', 'secret_file', 'outbound', 'background'];

// Tool calls worth a second look, and who let each one run.
function reviewSection(s) {
  const { counts, total, items } = s.review;
  if (!total) return null;
  const parts = KIND_ORDER.filter(kind => counts[kind]).map(kind => el('span', `tag k-${kind}`, t(`review.count.${kind}`, { n: counts[kind] })));
  const body = el('div', 'more-body');
  const list = el('ol', 'review');
  for (const item of items) {
    const row = el('li', `k-${item.kind}`);
    const head = el('div', 'review-head');
    head.append(
      el('span', 'tag', t(`rule.${item.rule}`, { host: item.host ?? '' })),
      item.count > 1 ? el('span', 'times', `×${item.count}`) : '',
    );
    // How the calls got through: "you were asked, then it ran ×5 · allowed by a rule, no prompt ×3".
    for (const how of ['refused', 'asked', 'rule']) {
      const n = item.approvals[how];
      if (n) head.append(el('span', `approval a-${how}`, t(`approval.${how}`) + (item.count > 1 ? ` ×${n}` : '')));
    }
    head.append(ticking('review-time', 'time.ago', item.at));
    row.append(head);
    if (item.count > 1) row.append(el('div', 'box-label', t('review.latest')));
    row.append(el('code', '', item.text));
    list.append(row);
  }
  body.append(list);
  body.append(el('p', 'reason', t('review.note')));
  if (s.review.more > 0) body.append(el('p', 'reason', t('review.more', { n: s.review.more })));
  return section(`${s.id}:review`, 'review-section', [el('span', 'more-title', t('review.title')), ...parts], body);
}

// Strip under the summary: model server, MCP servers, configured services.
function renderEnvironment() {
  const env = snapshot?.environment;
  const node = $('env');
  node.replaceChildren();
  if (!env) return;
  const group = (label, chips) => {
    if (!chips.length) return;
    const wrap = el('div', 'env-group');
    wrap.append(el('span', 'env-label', label), ...chips);
    node.append(wrap);
  };
  const chip = (state, name, note, title) => {
    const c = el('span', `chip ${state}`);
    c.append(el('span', 'dot'), el('span', '', name));
    if (note) c.append(el('span', 'chip-note', note));
    if (title) c.title = title;
    return c;
  };
  const checked = item => (item.ok == null
    ? chip('', item.name, '…', item.target)
    : chip(item.ok ? 'ok' : 'bad', item.name, item.ok ? `${item.ms} ms` : t(`env.${item.error ?? 'error'}`, { status: item.status ?? '' }), item.target));

  group(t('env.model'), env.models.map(checked));
  group(t('env.mcp'), env.mcp.filter(m => m.status !== 'disabled').map(m => {
    const state = m.status === 'failed' ? 'bad' : m.status === 'ok' ? 'ok' : '';
    const note = m.status === 'failed' ? t(`env.mcp.${m.kind}`) : m.status === 'ok' ? '' : t('env.mcp.unknown');
    return chip(state, m.name, note, t(`env.mcp.tip.${m.status}`));
  }));
  group(t('env.services'), env.services.map(checked));
}

function card(s, children) {
  const active = s.state !== 'finished' && s.state !== 'idle';
  const node = el('article', `card s-${s.state}${active ? '' : ' quiet'}`);

  const head = el('div', 'card-head');
  head.append(el('span', 'pill', t(`state.${s.state}`)));
  head.append(ticking('elapsed', active ? 'time.for' : 'time.ago', s.since));
  const project = el('span', 'project', s.project);
  project.title = s.directory;
  head.append(project);
  node.append(head);

  node.append(el('h2', 'title', s.title || s.id));
  // The prompt box carries the same sentence as its label.
  if (!s.prompt?.detail) node.append(el('p', 'reason', reasonText(s)));

  if (s.prompt?.detail) node.append(box('prompt', reasonText(s), s.prompt.detail));
  else if (active && s.current?.summary) {
    const current = box('', s.current.tool, s.current.summary, s.current.startedAt);
    if (s.current.tool === 'bash') current.append(outputBlock(s.current));
    node.append(current);
  }
  const progress = active ? progressBlock(s) : null;
  if (progress) node.append(progress);

  if (active && s.health.lastError && (s.state === 'error' || s.state === 'stuck')) {
    node.append(box('', t('health.lastError', { tool: s.health.lastError.tool }), s.health.lastError.text));
  }

  node.append(healthRow(s));
  const hints = active ? hintList(s) : null;
  if (hints) node.append(hints);
  for (const extra of [workSection(s), reviewSection(s)]) if (extra) node.append(extra);

  if (children.length) {
    const wrap = el('div', 'children');
    wrap.append(el('div', 'children-label', t('subagents')));
    for (const child of children) {
      const row = el('div', `child s-${child.state}`);
      row.append(el('span', 'pill', t(`state.${child.state}`)), el('span', 'child-title', child.title || child.id), ticking('elapsed', '', child.since));
      wrap.append(row);
    }
    node.append(wrap);
  }
  return node;
}

let historyEvents = [];
let historyLoadedAt = -1; // historyCount the list was fetched at

const currentTab = () => (location.hash === '#history' && snapshot?.historyCount != null ? 'history' : 'now');

async function loadHistory() {
  if (historyLoadedAt === snapshot.historyCount) return;
  const count = snapshot.historyCount;
  try {
    historyEvents = await (await fetch('/api/history')).json();
    historyLoadedAt = count;
    renderHistory();
  } catch {
    // Next snapshot tries again.
  }
}

function renderHistory() {
  const onlyAttention = $('history-filter').checked;
  const events = historyEvents.filter(e => !onlyAttention || NEEDS_YOU.has(e.to) || NEEDS_YOU.has(e.from));
  const list = $('history-list');
  list.replaceChildren();
  if (!events.length) {
    const empty = el('div', 'empty');
    empty.append(el('strong', '', t('history.empty')), t('history.emptyBody'));
    list.append(empty);
    return;
  }
  const lang = $('lang').value;
  const dayFormat = new Intl.DateTimeFormat(lang, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const timeFormat = new Intl.DateTimeFormat(lang, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  let day = '';
  let group;
  for (const e of events) {
    const label = dayFormat.format(e.t);
    if (label !== day) {
      day = label;
      list.append(el('h2', 'day', label));
      group = el('ol', 'events');
      list.append(group);
    }
    const row = el('li', `event s-${e.to}`);
    row.append(el('time', '', timeFormat.format(e.t)));
    const body = el('div', 'event-body');
    const head = el('div', 'event-head');
    head.append(el('span', 'pill', t(`state.${e.to}`)), el('span', 'event-title', e.title || e.id), el('span', 'project', e.project));
    body.append(head);
    const why = t(`reason.${e.reason}`, { permission: e.permission ?? '', limit: e.limitMs ? roughDuration(e.limitMs) : '', detail: e.error ?? '' });
    const before = e.from ? t('history.after', { state: t(`state.${e.from}`), t: duration(e.fromMs) }) : t('history.firstSeen');
    body.append(el('p', 'reason', `${why} · ${before}`));
    if (e.detail && e.to !== 'finished' && e.to !== 'idle') body.append(el('code', 'event-detail', e.detail));
    row.append(body);
    group.append(row);
  }
}

function render() {
  document.documentElement.lang = $('lang').value;
  const tab = currentTab();
  $('tabs').hidden = snapshot?.historyCount == null;
  for (const link of document.querySelectorAll('[data-tab]')) link.classList.toggle('active', link.dataset.tab === tab);
  $('sessions').hidden = tab !== 'now';
  $('history').hidden = tab !== 'history';
  if (tab === 'history') loadHistory();
  for (const node of document.querySelectorAll('[data-i18n]')) node.textContent = t(node.dataset.i18n);

  const stale = snapshot?.stale;
  $('conn').className = `chip ${connected && !stale ? 'ok' : 'bad'}`;
  $('conn-text').textContent = t(!connected ? 'conn.lost' : stale ? 'conn.stale' : 'conn.live');

  const running = snapshot?.opencodeRunning;
  $('oc').className = `chip ${running === true ? 'ok' : running === false ? 'bad' : ''}`;
  $('oc-text').textContent = t(running === true ? 'oc.running' : running === false ? 'oc.stopped' : 'oc.unknown');

  if (!snapshot) return;
  renderEnvironment();

  const all = snapshot.sessions ?? [];
  const ids = new Set(all.map(s => s.id));
  const top = all
    .filter(s => !s.parentId || !ids.has(s.parentId))
    .sort((a, b) => RANK[a.state] - RANK[b.state] || b.updatedAt - a.updatedAt);

  const attention = top.filter(s => NEEDS_YOU.has(s.state)).length;
  document.title = `${attention ? `(${attention}) ` : ''}${t('app.title')}`;

  const summary = $('summary');
  summary.replaceChildren();
  summary.append(el('div', `summary-lead${attention ? ' attention' : ''}`, attention ? t('summary.attention', { n: attention }) : t('summary.none')));
  const counts = el('div', 'summary-counts');
  for (const state of Object.keys(RANK)) {
    const n = top.filter(s => s.state === state).length;
    if (!n) continue;
    const item = el('span');
    item.append(el('b', '', String(n)), ` ${t(`state.${state}`)}`);
    counts.append(item);
  }
  summary.append(counts);

  const main = $('sessions');
  main.replaceChildren();
  if (!top.length) {
    const empty = el('div', 'empty');
    empty.append(el('strong', '', t('empty.title')), t('empty.body', { h: snapshot.lookbackHours }));
    main.append(empty);
  }
  for (const s of top) main.append(card(s, all.filter(c => c.parentId === s.id)));
  refreshClocks();
}

async function setLanguage(lang) {
  const load = async code => (await fetch(`/i18n/${code}.json`)).json();
  if (!Object.keys(fallback).length) fallback = await load('en');
  strings = lang === 'en' ? fallback : await load(lang).catch(() => fallback);
  $('lang').value = lang;
  try {
    localStorage.setItem('lang', lang);
  } catch {
    // Storage can be unavailable; the choice just will not be remembered.
  }
  render();
}

function connect() {
  const source = new EventSource('/api/events');
  source.onmessage = event => {
    snapshot = JSON.parse(event.data);
    clockSkew = Date.now() - snapshot.now;
    connected = true;
    render();
  };
  // EventSource retries by itself; just show that the feed is down meanwhile.
  source.onerror = () => {
    connected = false;
    render();
  };
}

let saved = null;
try {
  saved = localStorage.getItem('lang');
} catch {
  // See setLanguage.
}
const preferred = new URLSearchParams(location.search).get('lang') ?? saved ?? navigator.language.slice(0, 2);
$('lang').addEventListener('change', async event => {
  await setLanguage(event.target.value);
  renderHistory();
});
$('history-filter').addEventListener('change', renderHistory);
addEventListener('hashchange', render);
await setLanguage(LANGS.includes(preferred) ? preferred : 'en');
connect();
setInterval(refreshClocks, 1000);
