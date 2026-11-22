/**
 * README 产品截图生成器 —— **离线**，不联网。
 *
 * 三样东西都是真的：真 `client.js` 组件 + 真插件 CSS（从 client 侧注入的 `<style>` 里原样取回）
 * + 真 DSH 主题 token（从安装包里的 `dsh-client-ui-theme` 取回）。假的只有数据：
 * 一套虚构的 APP / OPS 工作项，**不含任何真实站点、邮箱或 issue 摘要**。
 *
 * 出图方式：把组件树（迷你 React 渲染出的宿主元素树）序列化成静态 HTML，交给无头 Chrome 截图，
 * 所以图上就是真组件 + 真 CSS 的样子，只是没有交互。
 *
 * 用法：
 *   BIN="/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness"
 *   ELECTRON_RUN_AS_NODE=1 "$BIN" test/dsh-jira-shot.mjs                 # en + zh，浅色主题
 *   ELECTRON_RUN_AS_NODE=1 "$BIN" test/dsh-jira-shot.mjs --theme dark    # 深色主题
 *   ELECTRON_RUN_AS_NODE=1 "$BIN" test/dsh-jira-shot.mjs --only panel    # 只出一张
 *
 * 产出（默认写进 `docs/images/`，被两份 README 引用）：
 *   panel.png            浮层列表（分组 / 优先级底色 / 状态筛选 / 项目 tab）
 *   panel-watch.png      实时监视横幅 + 某一行展开的状态流转下拉
 *   plan-flow.png        绑定工作区 → 点「计划」的四步图解（示意图，不是真截图）
 *   sidebar-entry.png    左侧栏入口 + 未读角标
 *   zh 版本加 `.zh` 后缀
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { homedir, tmpdir } from 'node:os';

/* --------------------------------------------------------------- 参数 / 路径 */

const HERE = dirname(fileURLToPath(import.meta.url));
const WS = resolve(HERE, '..');
const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback;
};
const LANGS = argOf('lang', 'en,zh').split(',').map((tag) => tag.trim()).filter(Boolean);
const THEME = argOf('theme', 'light') === 'dark' ? 'dark' : 'light';
const ONLY = argOf('only', '').trim();
const OUT_DIR = resolve(WS, argOf('out', 'docs/images'));
const SHOT_DIR = join(tmpdir(), 'dsh-jira-shot');
/* 无头浏览器：DSH_JIRA_CHROME 优先；否则按平台在常见安装位置里找第一个存在的
   （macOS 的 .app、Windows 的 Program Files 三处、Linux 的 PATH 命令名与 snap / flatpak 路径）。
   Chrome 的新版无头模式是 `--headless=new`，所以只认 Chrome / Chromium，不认 Edge。 */
function findChrome() {
  const explicit = String(process.env.DSH_JIRA_CHROME || '').trim();
  if (explicit) return explicit;
  let home = '';
  try { home = homedir(); } catch { home = ''; }
  const candidates = process.platform === 'darwin'
    ? [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      join(home, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ]
    : process.platform === 'win32'
      ? [
        join(process.env.ProgramFiles || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        join(process.env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'Google', 'Chrome', 'Application', 'chrome.exe'),
      ]
      : [
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/snap/bin/chromium',
        '/var/lib/flatpak/exports/bin/com.google.Chrome',
        join(home, '.local/share/flatpak/exports/bin/com.google.Chrome'),
      ];
  const found = candidates.find((file) => file && existsSync(file));
  if (found) return found;
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    try {
      const resolved = execFileSync(process.platform === 'win32' ? 'where' : 'which', [name], { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString().split(/\r?\n/)[0].trim();
      if (resolved) return resolved;
    } catch { /* 没装就下一个 */ }
  }
  return candidates[0];
}
const CHROME = findChrome();
/* Linux 上以 root 跑（CI / 容器）时 Chrome 拒绝启动，必须关掉沙箱；普通用户不要关。 */
const ROOT_CHROME_ARGS = (() => {
  try {
    return typeof process.getuid === 'function' && process.getuid() === 0 ? ['--no-sandbox'] : [];
  } catch {
    return [];
  }
})();
/* DSH 的安装目录：主题 token 从它的 app.asar 里取。DSH_JIRA_ASAR 优先；
   否则按平台列常见安装位，取第一个存在的（取不到只影响观感，脚本会 WARN 后继续）。 */
function findAsar() {
  const explicit = String(process.env.DSH_JIRA_ASAR || '').trim();
  if (explicit) return explicit;
  let home = '';
  try { home = homedir(); } catch { home = ''; }
  const candidates = process.platform === 'darwin'
    ? ['/Applications/DeepSeek Harness.app/Contents/Resources/app.asar', join(home, 'Applications/DeepSeek Harness.app/Contents/Resources/app.asar')]
    : process.platform === 'win32'
      ? [
        join(process.env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'Programs', 'DeepSeek Harness', 'resources', 'app.asar'),
        join(process.env.ProgramFiles || 'C:\\Program Files', 'DeepSeek Harness', 'resources', 'app.asar'),
      ]
      : [
        '/opt/DeepSeek Harness/resources/app.asar',
        '/usr/lib/deepseek-harness/resources/app.asar',
        '/usr/share/deepseek-harness/resources/app.asar',
        '/opt/deepseek-harness/resources/app.asar',
      ];
  return candidates.find((file) => file && existsSync(file)) || candidates[0];
}
const ASAR = findAsar();
const THEME_CSS = [
  `${ASAR}/dsh/node_modules/@deepseek-ai/dsh-client-ui-theme/src/styles/base.css`,
  `${ASAR}/dsh/node_modules/@deepseek-ai/dsh-client-ui-theme/src/styles/design-platform.css`,
];

if (!existsSync(CHROME)) {
  console.log(`SKIP: 找不到无头浏览器（${CHROME}）；用 DSH_JIRA_CHROME=<path> 指定。`);
  process.exit(0);
}
mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(SHOT_DIR, { recursive: true });

const dshThemeCss = THEME_CSS
  .map((file) => (existsSync(file) ? readFileSync(file, 'utf8') : ''))
  .join('\n');
if (!dshThemeCss.includes('--dsw-alias-bg-layer-2')) {
  console.log('WARN: 读不到 DSH 主题 token，退回插件自带的兜底色（观感会差一点）。');
}

/* ------------------------------------------------------------- 迷你 React */
/* 与 dsh-jira-visual.mjs 同款：client.js 只用到 createElement/useState/useEffect/useRef。 */

const hookStore = new Map();
let currentComponent = '';
let hookIndex = 0;

function flatten(list) {
  return list.flat(Infinity).filter((item) => item !== null && item !== undefined && item !== false && item !== true);
}

function createElement(type, props, ...children) {
  return { type, props: props ?? {}, children: flatten(children) };
}

function slot(index) {
  let list = hookStore.get(currentComponent);
  if (!list) {
    list = [];
    hookStore.set(currentComponent, list);
  }
  while (list.length <= index) list.push({});
  return list[index];
}

const React = {
  createElement,
  useState(initial) {
    const cell = slot(hookIndex++);
    if (cell.value === undefined) cell.value = typeof initial === 'function' ? initial() : initial;
    // React 语义：返回这一拍的状态快照。面板会在 setState 的 updater 里读 snapshot，
    // 而真 React 的 updater 参数就是快照；返回同一个可变的 cell.value 会让 updater 里
    // 「复用上一拍快照」优化后的 patch 直接改到本地 state 上，模拟器就会多渲一拍。
    return [cell.value, (next) => { cell.value = typeof next === 'function' ? next(cell.value) : next; }];
  },
  useEffect(fn, deps) {
    const cell = slot(hookIndex++);
    const changed = cell.deps === undefined || !deps
      || deps.length !== cell.deps.length || deps.some((dep, i) => dep !== cell.deps[i]);
    if (!changed) return;
    cell.deps = deps;
    cell.cleanup?.();
    cell.cleanup = fn() ?? undefined;
  },
  useRef(initial) {
    const cell = slot(hookIndex++);
    if (cell.value === undefined) cell.value = { current: initial ?? null };
    return cell.value;
  },
};

function expand(element) {
  if (element === null || element === undefined || typeof element === 'boolean') return null;
  if (typeof element === 'string' || typeof element === 'number') {
    return { type: '#text', props: {}, children: [], text: String(element) };
  }
  if (typeof element.type === 'function') {
    const previous = currentComponent;
    const previousIndex = hookIndex;
    currentComponent = element.type.name || 'anonymous';
    hookIndex = 0;
    const rendered = element.type(element.props);
    currentComponent = previous;
    hookIndex = previousIndex;
    return expand(rendered);
  }
  return { ...element, children: flatten(element.children).map(expand).filter(Boolean) };
}

function walk(node, visit) {
  if (!node) return;
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}

function collect(node, predicate) {
  const hits = [];
  walk(node, (row) => {
    if (row.type !== '#text' && predicate(row)) hits.push(row);
  });
  return hits;
}

function text(node) {
  let out = '';
  walk(node, (row) => {
    if (row.type === '#text') out += row.text;
  });
  return out;
}

/* -------------------------------------------------- HTML 序列化（宿主元素树 → 静态 HTML） */

const VOID_TAGS = new Set(['img', 'br', 'hr', 'input', 'meta', 'link', 'source', 'area', 'base', 'col', 'embed', 'track', 'wbr']);
const UNITLESS = new Set(['opacity', 'zIndex', 'flex', 'flexGrow', 'flexShrink', 'order', 'fontWeight', 'lineHeight',
  'zoom', 'gridColumn', 'gridRow', 'aspectRatio', 'columnCount', 'tabSize', 'WebkitLineClamp', 'lineClamp', 'pointerEvents']);
const ATTR_NAMES = {
  className: 'class', htmlFor: 'for', tabIndex: 'tabindex', readOnly: 'readonly', autoComplete: 'autocomplete',
  maxLength: 'maxlength', colSpan: 'colspan', rowSpan: 'rowspan', contentEditable: 'contenteditable', spellCheck: 'spellcheck',
  fillRule: 'fill-rule', clipRule: 'clip-rule', strokeWidth: 'stroke-width', strokeLinecap: 'stroke-linecap',
  strokeLinejoin: 'stroke-linejoin', strokeDasharray: 'stroke-dasharray', strokeOpacity: 'stroke-opacity',
  fillOpacity: 'fill-opacity', textAnchor: 'text-anchor', dominantBaseline: 'dominant-baseline',
  fontFamily: 'font-family', fontSize: 'font-size', fontWeight: 'font-weight', xmlnsXlink: 'xmlns:xlink',
};
const KEEP_ATTR = new Set(['viewBox', 'preserveAspectRatio', 'gradientUnits', 'patternUnits', 'patternContentUnits', 'clipPathUnits', 'maskUnits', 'spreadMethod']);

function escapeText(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(value) {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function attrName(key) {
  if (ATTR_NAMES[key]) return ATTR_NAMES[key];
  if (KEEP_ATTR.has(key)) return key;
  if (/^[a-z][a-z0-9-]*$/.test(key)) return key;
  return key.replace(/[A-Z]/g, (hit) => `-${hit.toLowerCase()}`);
}

function cssText(style) {
  return Object.entries(style)
    .filter(([, value]) => value !== undefined && value !== null && value !== false)
    .map(([key, value]) => {
      const prop = key.startsWith('--') ? key : key.replace(/[A-Z]/g, (hit) => `-${hit.toLowerCase()}`);
      const next = typeof value === 'number' && !UNITLESS.has(key) ? `${value}px` : String(value);
      return `${prop}:${next}`;
    })
    .join(';');
}

function serialize(node) {
  if (!node) return '';
  if (node.type === '#text') return escapeText(node.text);
  const tag = node.type;
  const attrs = [];
  for (const [key, value] of Object.entries(node.props ?? {})) {
    if (key === 'key' || key === 'ref' || key === 'children' || key === 'dangerouslySetInnerHTML') continue;
    if (/^on[A-Z]/.test(key)) continue;
    if (value === undefined || value === null || value === false) continue;
    if (key === 'style') {
      const css = typeof value === 'string' ? value : cssText(value);
      if (css) attrs.push(`style="${escapeAttr(css)}"`);
      continue;
    }
    attrs.push(`${attrName(key)}="${escapeAttr(value === true ? 'true' : value)}"`);
  }
  const head = `<${tag}${attrs.length ? ` ${attrs.join(' ')}` : ''}>`;
  if (VOID_TAGS.has(tag)) return head;
  return `${head}${(node.children ?? []).map(serialize).join('')}</${tag}>`;
}

/* ------------------------------------------------------------------ DOM 桩 */

let styleTags = [];
let capturedCss = '';
const localeListeners = new Set();
const transport = {
  watchState: { payload: null },
  transitionCalls: [],
};

const documentStub = {
  head: { appendChild: (tag) => styleTags.push(tag) },
  body: {},
  activeElement: undefined,
  createElement: (tag) => ({
    tagName: tag, dataset: {}, style: {}, textContent: '',
    remove() { this.removed = true; },
  }),
  querySelector: (selector) => styleTags.find((tag) => selector.includes(tag.dataset.pluginCss)) ?? null,
  addEventListener() {},
  removeEventListener() {},
};

Object.defineProperty(globalThis, 'document', { value: documentStub, configurable: true });

/* ------------------------------------------------------------ 假数据（虚构） */

const STATUS_CATEGORY = { 'To Do': 'new', 'In Progress': 'indeterminate', 'IN QA': 'indeterminate', Done: 'done' };
const TRANSITIONS = [
  { id: '11', name: 'To Do', to: 'To Do', category: 'new', required: [] },
  { id: '21', name: 'In Progress', to: 'In Progress', category: 'indeterminate', required: [] },
  { id: '31', name: 'IN QA', to: 'IN QA', category: 'indeterminate', required: [] },
  { id: '41', name: 'Done', to: 'Done', category: 'done', required: [] },
];

const COPY = {
  en: {
    summaries: {
      'APP-412': 'Checkout: retry button stays disabled after a 5xx',
      'APP-398': 'Search indexer drops the last batch on restart',
      'APP-425': 'Add a dry-run mode to the release script',
      'APP-401': 'Flaky test: cart totals race the coupon job',
      'APP-377': 'Bump the base image to Node 22',
      'APP-450': 'Spike: replace the cron pinger with a queue',
      'APP-452': 'Document the sandbox escape hatches',
      'OPS-88': 'Rotate the staging TLS certificate',
      'APP-463': 'Empty state for the reports tab',
      'OPS-91': 'Cost alert fires twice for one cluster',
      'APP-470': 'Drop the unused legacyMode flag',
    },
    sprint24: 'APP Sprint 24',
    sprint25: 'APP Sprint 25',
    credentialSource: 'DSH credential store · JIRA_API_TOKEN',
    changeNew: 'New: {key}',
    changeFromTo: '{key}: {from} → {to}',
    epics: {
      'OPS-60': 'Keep the deploy pipeline green after the Node 22 move',
      'APP-300': 'Checkout resilience: retries, timeouts, idempotency',
    },
    epicNames: { 'OPS-60': 'Pipeline hygiene', 'APP-300': 'Checkout resilience' },
    search: 'checkout',
  },
  zh: {
    summaries: {
      'APP-412': '结算页：5xx 之后重试按钮一直是禁用的',
      'APP-398': '搜索索引重启时会丢掉最后一批',
      'APP-425': '发布脚本加一个 dry-run 模式',
      'APP-401': '不稳定用例：购物车合计和优惠券任务抢跑',
      'APP-377': '基础镜像升到 Node 22',
      'APP-450': '预研：把定时探测换成队列',
      'APP-452': '补文档：沙箱的逃生开关',
      'OPS-88': '轮换预发环境的 TLS 证书',
      'APP-463': '报表 tab 的空状态',
      'OPS-91': '一个集群重复触发两次成本告警',
      'APP-470': '删掉没人用的 legacyMode 开关',
    },
    sprint24: 'APP Sprint 24',
    sprint25: 'APP Sprint 25',
    credentialSource: 'DSH 凭据库 · JIRA_API_TOKEN',
    changeNew: '新增：{key}',
    changeFromTo: '{key}：{from} → {to}',
    epics: {
      'OPS-60': 'Node 22 升级后排稳发布流水线',
      'APP-300': '结算页韧性：重试、超时、幂等',
    },
    epicNames: { 'OPS-60': '流水线卫生', 'APP-300': '结算页韧性' },
    search: '结算',
  },
};

/** 一条工作项，字段与 host `--json` 载荷同形（camelCase，client 直接吃）。 */
function item(lang, key, priority, status, summaryKey, sprint, extra = {}) {
  const copy = COPY[lang];
  const epicKey = extra.epicKey ?? '';
  const parentKey = extra.parentKey ?? '';
  return {
    key,
    summary: copy.summaries[summaryKey ?? key] ?? key,
    status,
    category: STATUS_CATEGORY[status] ?? 'new',
    priority,
    parent: parentKey,
    parentKey,
    parentSummary: parentKey ? copy.epicNames[epicKey] ?? '' : '',
    epicKey,
    epicSummary: epicKey ? copy.epics[epicKey] ?? '' : '',
    type: epicKey === 'OPS-60' ? 'Sub-task' : 'Story',
    due: extra.due ?? '',
    overdue: Boolean(extra.overdue),
    updated: extra.updated ?? '2026-11-18',
    labels: extra.labels ?? [],
    url: `https://example.atlassian.net/browse/${key}`,
    project: key.split('-')[0],
    sprintId: sprint ? sprint.id : null,
    sprint: sprint ? sprint.name : '',
    sprintState: sprint ? sprint.state : '',
    sprintStart: sprint ? sprint.start : '',
    sprintEnd: sprint ? sprint.end : '',
  };
}

function demoPayload(lang) {
  const copy = COPY[lang];
  const S24 = { id: 24, name: copy.sprint24, state: 'active', start: '2026-11-09', end: '2026-11-22' };
  const S25 = { id: 25, name: copy.sprint25, state: 'future', start: '2026-11-23', end: '2026-12-06' };
  const s24 = [
    item(lang, 'APP-412', 'Highest', 'IN QA', null, S24, { due: '2026-11-20', updated: '2026-11-19', epicKey: 'APP-300' }),
    item(lang, 'APP-398', 'High', 'In Progress', null, S24, { due: '2026-11-21', epicKey: 'APP-300' }),
    item(lang, 'APP-425', 'Medium', 'To Do', null, S24, { parentKey: 'APP-300', epicKey: 'APP-300' }),
    item(lang, 'APP-401', 'Low', 'To Do', null, S24, { due: '2026-11-16', overdue: true }),
    item(lang, 'APP-377', 'Medium', 'Done', null, S24, { updated: '2026-11-14', epicKey: 'OPS-60' }),
  ];
  const s25 = [
    item(lang, 'APP-450', 'High', 'To Do', null, S25),
    item(lang, 'APP-452', 'Low', 'To Do', null, S25, { labels: ['docs'], parentKey: 'OPS-60', epicKey: 'OPS-60' }),
  ];
  const none = [
    item(lang, 'OPS-88', 'High', 'In Progress', null, null, { epicKey: 'OPS-60' }),
    item(lang, 'APP-463', 'Medium', 'IN QA', null, null, { updated: '2026-11-17', epicKey: 'APP-300' }),
    item(lang, 'OPS-91', 'Medium', 'To Do', null, null),
    item(lang, 'APP-470', 'Low', 'To Do', null, null),
  ];
  const items = [...s24, ...s25, ...none];
  const countsOf = (rows) => ({
    new: rows.filter((row) => row.category === 'new').length,
    indeterminate: rows.filter((row) => row.category === 'indeterminate').length,
    done: rows.filter((row) => row.category === 'done').length,
    total: rows.length,
  });
  const projectTotals = {};
  for (const row of items) projectTotals[row.project] = (projectTotals[row.project] ?? 0) + 1;
  return {
    ok: true,
    source: 'dsh-jira-work-overview',
    generatedAt: '2026-11-19T01:42:00.000Z',
    query: { scope: 'all', jql: 'assignee = currentUser() ORDER BY updated DESC' },
    project: '',
    credentialSource: copy.credentialSource,
    notes: [],
    counts: countsOf(items),
    status: '',
    statusOptions: Object.entries(STATUS_CATEGORY).map(([name, category]) => ({ name, category })),
    total: items.length,
    projectTotals,
    items,
    limit: 0,
    hasMore: false,
    sprints: [
      { id: 25, name: copy.sprint25, state: 'future', start: S25.start, end: S25.end, active: false, keys: s25.map((r) => r.key), counts: countsOf(s25) },
      { id: 24, name: copy.sprint24, state: 'active', start: S24.start, end: S24.end, active: true, keys: s24.map((r) => r.key), counts: countsOf(s24) },
      { id: null, name: '', state: '', start: '', end: '', active: false, keys: none.map((r) => r.key), counts: countsOf(none) },
    ],
  };
}

/**
 * 整站搜索的命中结果（虚构）：**不是指派给我的**——命中里有别人名下的卡，这正是搜索与「我的工作」的区别。
 * 形状与 `--json --search=…` 一致：同样的 items / sprints / counts / total，只是集合换成搜索命中。
 */
function searchPayload(lang) {
  const base = demoPayload(lang);
  const copy = COPY[lang];
  const S24 = base.sprints.find((row) => row.id === 24);
  const S25 = base.sprints.find((row) => row.id === 25);
  const sprint24 = { id: 24, name: copy.sprint24, state: 'active', start: S24.start, end: S24.end };
  const sprint25 = { id: 25, name: copy.sprint25, state: 'future', start: S25.start, end: S25.end };
  const hits = [
    item(lang, 'OPS-88', 'High', 'IN QA', null, sprint24, { epicKey: 'OPS-60', due: '2026-11-19' }),
    item(lang, 'APP-412', 'Highest', 'In Progress', null, sprint24, { epicKey: 'APP-300', updated: '2026-11-19' }),
    item(lang, 'APP-463', 'Medium', 'To Do', null, sprint25, { epicKey: 'APP-300' }),
    item(lang, 'APP-425', 'Low', 'Done', null, null, { epicKey: 'APP-300', updated: '2026-11-15' }),
  ];
  const inS24 = hits.filter((row) => row.sprintId === 24);
  const inS25 = hits.filter((row) => row.sprintId === 25);
  const orphan = hits.filter((row) => row.sprintId === null);
  const countsOf = (rows) => ({
    new: rows.filter((row) => row.category === 'new').length,
    indeterminate: rows.filter((row) => row.category === 'indeterminate').length,
    done: rows.filter((row) => row.category === 'done').length,
    total: rows.length,
  });
  const projectTotals = {};
  for (const row of hits) projectTotals[row.project] = (projectTotals[row.project] ?? 0) + 1;
  return {
    ...base,
    generatedAt: '2026-11-20T02:10:00.000Z',
    query: { scope: 'all', search: copy.search, jql: `text ~ "${copy.search}" ORDER BY updated DESC` },
    counts: countsOf(hits),
    total: hits.length,
    projectTotals,
    items: hits,
    sprints: [
      { ...S25, keys: inS25.map((row) => row.key), counts: countsOf(inS25) },
      { ...S24, keys: inS24.map((row) => row.key), counts: countsOf(inS24) },
      { id: null, name: '', state: '', start: '', end: '', active: false, keys: orphan.map((row) => row.key), counts: countsOf(orphan) },
    ],
  };
}

const CLEAN_WATCH = { enabled: true, watchEnabled: true, watchIntervalMs: 60000, counts: { new: 0, status: 0, closed: 0, total: 0 }, changes: [] };const UNREAD_WATCH = {
  enabled: true,
  watchEnabled: true,
  watchIntervalMs: 60000,
  counts: { new: 2, status: 1, closed: 0, total: 3 },
  changes: [
    { kind: 'new', key: 'APP-470', summary: '—', status: 'To Do', at: '2026-11-19T01:40:00.000Z' },
    { kind: 'status', key: 'APP-398', summary: '—', from: 'To Do', to: 'In Progress', at: '2026-11-19T01:38:00.000Z' },
    { kind: 'closed', key: 'APP-377', summary: '—', from: 'Done', to: '', at: '2026-11-19T01:31:00.000Z' },
  ],
};

/* ------------------------------------------------------------- 虚拟列表替身 */

/* 与 visual 套件不同：这里要**真的**按条目给位移与高度，因为截图上行的位置就是最终观感。
   Panel 每次都把完整的 entries 数组交给 `useVirtualizer({ count, getItemKey })`；条目高度先按 estimateSize
   估，出图前再用 measureRows() 在无头 Chrome 里量真实高度（真 CSS 决定），量不到才退回估高。 */
let currentEntries = {};
/* 每张图最多给多少条（组头 + 任务行一起算）：真库只给视口内的窗口，这里默认 0 = 整张列表都画。
   需要模拟「滚到一半」的图再把它调小。 */
let SHOT_ROWS = 0;
/* 每张图落的 DOM 量一次：面板的行高就取自真 CSS 的表格布局，所以这里拿到的高度就是浏览器里的高度
   （先按估高把所有行都挂上，量完再按真实高度重排——真库量行也是这个顺序）。 */
const MEASURE_JS = `(() => {
  const rows = Array.prototype.slice.call(document.querySelectorAll('.jmw-vrow'));
  const out = rows.map((node) => [Number(node.getAttribute('data-index')), Math.round(node.getBoundingClientRect().height)]);
  document.documentElement.setAttribute('data-measured', JSON.stringify(out));
})();`;

/* 本次虚拟列表拿到的条目标识（Token：组头 `g:<组>` / 任务行 `i:<issue>`，与 Panel 的 getItemKey 一致），
   量行高时按 data-index 对回条目 key。每次 useVirtualizer 调用都会被换成这一拍的列表。 */
let currentTokens = [];

function makeVirtualizer(options) {
  const count = Math.max(0, Number(options?.count) || 0);
  const keys = Array.from({ length: count }, (_, index) => (options.getItemKey ? options.getItemKey(index) : index));
  currentTokens = keys.map((key, index) => ({ key, index }));
  const sizes = keys.map((key, index) => {
    const estimate = Math.max(1, Number(options?.estimateSize?.(index) ?? ROW_H) || ROW_H);
    // 量出来的真实高度（measureRows 回填 / 各图手写的展开高度）优先，没量到就用估高。
    return currentEntries[key] ?? estimate;
  });
  const starts = [];
  let total = 0;
  for (let index = 0; index < count; index += 1) {
    starts.push(total);
    total += sizes[index];
  }
  // 量高那一轮（MEASURING）把整张列表都挂上；平时 SHOT_ROWS > 0 时只画前 N 条，模拟真库的窗口。
  const shown = MEASURING || SHOT_ROWS <= 0 ? count : Math.min(count, SHOT_ROWS);
  const items = Array.from({ length: shown }, (_, index) => ({ index, key: keys[index], start: starts[index], size: sizes[index] }));
  return {
    getTotalSize: () => total,
    getVirtualItems: () => items,
    measureElement: () => undefined,
    scrollToIndex: () => undefined,
  };
}

/* ------------------------------------------------------------------ 加载 client */

const slotRegistrations = [];
const effects = [];

/**
 * `options.search`  —— 搜索框里的关键词（非空时命令面收到 `--search=`，回搜索命中载荷）
 * `options.workspace` —— 当前会话所在的工作区 id（面板按它自动选项目 tab）
 * `options.plans`   —— 已绑定的计划对话 `{ ISSUE: sessionId }`（任务行「计划」标成 on + 多个「×」）
 */
async function loadClient(lang, options = {}) {
  hookStore.clear();
  currentComponent = '';
  hookIndex = 0;
  styleTags = [];
  capturedCss = '';
  slotRegistrations.length = 0;
  effects.length = 0;
  Object.defineProperty(globalThis, 'navigator', { value: { language: lang === 'zh' ? 'zh-CN' : 'en-US', languages: [lang === 'zh' ? 'zh-CN' : 'en-US'] }, configurable: true });

  const loaded = [];
  const languageTransitions = TRANSITIONS.map((row) => ({ ...row }));
  const sessions = { 'sess-main': { id: 'sess-main', workspaceId: options.workspace ?? '' } };
  const payload = demoPayload(lang);
  const searchPayloadData = searchPayload(lang);
  const commandCalls = [];
  const plans = { sessions: { ...(options.plans ?? {}) } };

  const clientCtx = {
    get(name) {
      if (name === 'sessions') return { list: { getSnapshot: () => ({ byId: sessions }) } };
      if (name === 'remote.commands') {
        return {
          async execute(sessionId, line) {
            await new Promise((done) => setTimeout(done, 20));
            commandCalls.push(String(line));
            // 带 `--search=` 的那次查询回搜索命中（与真 host 一样：同一份载荷形状，集合换了）。
            const searched = /--search=(.+)$/.exec(String(line));
            const data = searched && searched[1].trim() ? searchPayloadData : payload;
            return { ok: true, value: { commandId: 'jira', result: { kind: 'success', text: JSON.stringify(data) } } };
          },
        };
      }
      return undefined;
    },
    effect(fn) { const off = fn(); effects.push(off); return () => {}; },
    on(name, handler) { if (name === 'locale/change') localeListeners.add(handler); },
    slots: {
      inject(name, factory) { factory(); },
      register(options, component) { slotRegistrations.push({ options, component }); return () => {}; },
    },
  };

  Object.defineProperty(globalThis, 'window', {
    value: {
      __ModuleLoader__: { load(spec) { loaded.push(spec); } },
      __DSH_TRANSPORT__: {
        async fetch(url, init = {}) {
          const path = String(url).split('?')[0];
          if (path === '/api/jira-work-overview/transition') {
            const key = new URL(url, 'http://shot.invalid').searchParams.get('key') ?? '';
            const current = payload.items.find((row) => row.key === key)?.status ?? 'To Do';
            transport.transitionCalls.push({ method: init.method ?? 'GET', key });
            return { ok: true, status: 200, async json() { return { ok: true, key, current, currentCategory: STATUS_CATEGORY[current] ?? 'new', transitions: languageTransitions }; } };
          }
          // 工作区 ↔ 项目：sess-main 所在的工作区关联了 APP（面板打开时据此落到 APP tab）。
          if (path === '/api/jira-work-overview/project-workspace') {
            return { ok: true, status: 200, async json() { return { ok: true, mapping: options.workspace ? { APP: [options.workspace] } : {}, workspaces: {}, items: [] }; } };
          }
          // 计划对话映射：列表里「计划」按钮的 on 状态、「×」都读它。
          if (path === '/api/jira-work-overview/plan') {
            return { ok: true, status: 200, async json() { return { ok: true, sessions: { ...plans.sessions } }; } };
          }
          // 后台监视通道：客户端是长轮询，这里立刻回。
          await new Promise((done) => setTimeout(done, 15));
          return { ok: true, status: 200, async json() { return { ok: true, watch: transport.watchState.payload ?? CLEAN_WATCH, now: new Date().toISOString() }; } };
        },
      },
    },
    configurable: true,
  });

  await import(`${pathToFileURL(`${WS}/client.js`).href}?shot=${lang}-${Date.now()}`);
  const spec = loaded[0];
  if (!spec) throw new Error('client.js 没有调用 window.__ModuleLoader__.load');
  const mod = spec.factory((name) => {
    if (name === 'react') return React;
    if (name === 'react-dom') return { createPortal: (node) => node };
    if (name === '@tanstack/react-virtual') return { useVirtualizer: makeVirtualizer };
    return undefined;
  });
  mod.apply(clientCtx);
  capturedCss = styleTags.map((tag) => tag.textContent).join('\n');
  return { mod, payload, commandCalls };
}

const tick = () => new Promise((done) => setTimeout(done, 5));
async function settle(ms = 120) {
  const until = Date.now() + ms;
  while (Date.now() < until) await new Promise((done) => setTimeout(done, 10));
  await tick();
  await tick();
}

/* ------------------------------------------------------------------ 页面组装 */

const entryComponent = () => slotRegistrations.find((row) => row.options.id === 'jira-work-overview').component;
const panelComponent = () => slotRegistrations.find((row) => row.options.id === 'jira-work-overview-panel').component;

function renderEntry(wide = true) {
  currentComponent = 'Entry';
  hookIndex = 0;
  return expand(createElement(entryComponent(), { wide }));
}

/* 每一次当拍渲染都是新的组件实例（真 React 里同一个 tick 的多次渲染会丢弃后一次的 state）。
   模拟器没有这一步，不区分的话 `setState(updater)` 会在旧的共享 snapshot 上叠加。 */
let renderTick = 0;
function renderPanel() {
  renderTick += 1;
  currentComponent = `Panel#${renderTick}`;
  hookIndex = 0;
  return expand(createElement(panelComponent(), {}));
}

const SHOT_CSS = `
html,body{margin:0;height:100%}
body{background:color-mix(in srgb, var(--dsw-alias-bg-base,#fff) 94%, var(--dsw-alias-label-primary,#1b1d22))}
.shot{height:100%;box-sizing:border-box}
.shot-rail{height:100%;box-sizing:border-box;padding:8px;display:flex;flex-direction:column;justify-content:flex-end;
  background:var(--dsw-alias-bg-layer-1,#fff);border-right:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.06))}
.shot-rail .jmw-entry{color:var(--dsw-alias-label-primary,#1b1d22)}
.shot-rail-wrap{padding-top:6px;border-top:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.06))}
.shot-main{position:relative;height:100%;box-sizing:border-box}
.jmw-mask{position:absolute;background:transparent}
`;

function pageHtml(title, body) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeAttr(title)}</title>
<style>${dshThemeCss}</style>
<style>${capturedCss}</style>
<style>${SHOT_CSS}</style>
</head><body${THEME === 'dark' ? ' data-ds-dark-theme' : ''}>
${body}
</body></html>`;
}

function shot(name, html, width, height) {
  const base = join(SHOT_DIR, `${name}-${THEME}`);
  writeFileSync(`${base}.html`, html);
  // 浅色是 README 用的那一套；深色加后缀，不会覆盖它（`--theme dark` 只用来抽查深色观感）。
  const png = join(OUT_DIR, `${name}${THEME === 'dark' ? '-dark' : ''}.png`);
  const args = [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
    ...ROOT_CHROME_ARGS,
    '--force-color-profile=srgb', '--force-device-scale-factor=2', '--virtual-time-budget=1200',
    `--user-data-dir=${join(SHOT_DIR, 'chrome-profile')}`,
    `--window-size=${width},${height}`, `--screenshot=${png}`, pathToFileURL(`${base}.html`).href,
  ];
  execFileSync(CHROME, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  const size = readFileSync(png).length;
  console.log(`${name.padEnd(16)} ${width}x${height} @2x  →  ${png.replace(`${WS}/`, '')}  (${Math.round(size / 1024)} KB)`);
}

/* ------------------------------------------------------------------ 出图 */

const WANTED = (name) => !ONLY || ONLY === name;
const PANEL_W = 1040;
const PANEL_H = 900;
const RAIL_W = 248;
const RAIL_H = 54;
/* 「计划」那张图要拍到前两组的那几行（Sprint 25 两行 + Sprint 24 的表头），再往下只裁到图片边缘。 */
const PLAN_SHOT_H = 640;
/* 行高估算：与 client.js 的 `useVirtualizer({ estimateSize: () => 32 })` 同口径。 */
const ROW_H = 32;

/* 打开面板：点左侧栏入口，等 client 先把列表 / 工作区映射 / 计划映射拉回来。 */
async function openPanel(lang, options = {}) {
  const loaded = await loadClient(lang, options);
  const entry = renderEntry(true);
  collect(entry, (row) => row.type === 'button')[0].props.onClick();
  await settle(240);
  return loaded;
}

/* 当前渲染树里的一行（按 issue key 认）。 */
function rowOf(panel, key) {
  const row = collect(panel, (node) => String(node.props.className ?? '').split(' ')[0] === 'jmw-row')
    .find((node) => text(node).includes(key));
  if (!row) throw new Error(`截图数据里找不到 ${key} 那一行`);
  return row;
}

/* 量行高的那一轮标记（见 MEASURE_JS）。 */
let MEASURING = false;

/**
 * 出图前量一次行高：先按估高渲一遍，再让无头 Chrome 把每个 .jmw-vrow 的实际高度写进 HTML
 * （行高由真 CSS 决定），按 data-index 回填后渲第二遍——真库量完行也是这样重排。
 * 量不到（空列表等）就保持估高，不影响出图。
 */
function measureRows(name, panel, width, height) {
  MEASURING = true;
  const html = pageHtml(`${name}-measure`, panelHtml(name, panel));
  MEASURING = false;
  const file = join(SHOT_DIR, `${name}-measure-${THEME}.html`);
  // 在页面末尾挂一段同步脚本：量完把行高写进 <html data-measured="[[index,height],…]">，
  // --dump-dom 打出来的就是量过的 DOM。
  writeFileSync(file, html.replace('</body>', `<script>${MEASURE_JS}</script></body>`));
  const tokens = currentTokens;
  const dom = execFileSync(CHROME, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
    ...ROOT_CHROME_ARGS,
    '--force-color-profile=srgb', `--window-size=${width},${height}`, '--virtual-time-budget=800', '--dump-dom',
    `--user-data-dir=${join(SHOT_DIR, 'chrome-profile')}`, pathToFileURL(file).href,
  ], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
  const match = /data-measured="([^"]*)"/.exec(dom);
  if (!match) throw new Error(`${name}: 没量到行高（data-measured 缺失）`);
  const payload = JSON.parse(match[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
  let filled = 0;
  for (const [index, height] of payload) {
    const token = tokens[Number(index)];
    if (!token || !(height > 0)) continue;
    currentEntries[token.key] = height;
    filled += 1;
  }
  if (!filled) throw new Error(`${name}: 量到 ${payload.length} 行但没对上任何条目`);
}

function panelHtml(name, panel) {
  return pageHtml(name, `<div class="shot"><div class="shot-main">${serialize(panel)}</div></div>`);
}


/* ------------------------------------------------------------------ 「计划」四步图解 */

/**
 * 绑定工作区 → 点「计划」的四步图解。
 * 不是真截图（真截图拍不到「右键菜单 + 系统会话切换」），所以用面板同一套 CSS token 画示意卡片，
 * 文案与 client.js 的 M 字典逐字对齐，免得图和真实界面说两套话。
 */
const PLAN_FLOW = {
  zh: {
    steps: [
      {
        n: '1', title: '把工作区关联到一个 Jira 项目',
        mock: 'menu',
        note: '左侧栏里对工作区那一行右键 →「关联 Jira 项目…」。一个工作区同时只挂一个项目；换项目时，原项目会让出这个工作区。',
      },
      {
        n: '2', title: '点项目 tab，完成关联',
        mock: 'tabs',
        note: '菜单点完面板会自动打开，顶部提示「点上面的项目 tab，把它关联到当前工作区。」——候选 tab 带虚线框，点哪个就挂哪个。候选要等面板至少拉到过一次 issue 才会出现。',
      },
      {
        n: '3', title: '点任务行末尾的「☰ 计划」',
        mock: 'row',
        note: '在该项目绑定的工作区里新建一条 plan 模式会话：首条消息只要求「列出将要执行的修改任务」，你敲定后才动手；卡片信息不全时会中断并说明缺什么。',
      },
      {
        n: '4', title: '回到面板：按钮变蓝 = 已计划',
        mock: 'rowon',
        note: '再点只打开原来那条对话，不会重复建；鼠标移到行上会出现 ×，点它把会话归档并解绑（可从归档区恢复）。',
      },
    ],
    workspace: 'dsh-jira-work-overview',
    menuLink: '关联 Jira 项目…',
    hint: '点上面的项目 tab，把它关联到当前工作区。',
    cancel: '取消',
    all: '全部项目 12', project: 'APP 9', other: 'OPS 3',
    key: 'APP-412', summary: '结算页偶发 500', status: '进行中', plan: '计划',
  },
  en: {
    steps: [
      {
        n: '1', title: 'Link the workspace to a Jira project',
        mock: 'menu',
        note: 'Right-click the workspace row in the left sidebar → “Link Jira project…”. A workspace holds one project at a time; linking another moves it over.',
      },
      {
        n: '2', title: 'Click a project tab to finish',
        mock: 'tabs',
        note: 'The panel opens with “Click a project tab above to link it to the current workspace.” — candidate tabs are dashed; click one to link it. Candidates appear once the panel has fetched issues.',
      },
      {
        n: '3', title: 'Click the “☰ Plan” chip on a row',
        mock: 'row',
        note: 'Creates a planning-mode session in that project’s workspace: the first message only asks for the list of edits to make; nothing runs until you confirm. A card missing key fields stops and says what is missing.',
      },
      {
        n: '4', title: 'Back in the panel: blue = planned',
        mock: 'rowon',
        note: 'Clicking again only reopens that conversation — never a second one. Hovering the row shows ×; it archives the session and unbinds it (recoverable from the archive).',
      },
    ],
    workspace: 'dsh-jira-work-overview',
    menuLink: 'Link Jira project…',
    hint: 'Click a project tab above to link it to the current workspace.',
    cancel: 'Cancel',
    all: 'All projects 12', project: 'APP 9', other: 'OPS 3',
    key: 'APP-412', summary: 'Checkout page: intermittent 500', status: 'In Progress', plan: 'Plan',
  },
};

const PLAN_FLOW_CSS = `
body{background:color-mix(in srgb, var(--dsw-alias-bg-base,#fff) 94%, var(--dsw-alias-label-primary,#1b1d22))}
.pf{height:100%;box-sizing:border-box;padding:20px;display:grid;grid-template-columns:1fr 1fr;grid-auto-rows:1fr;gap:16px;
  font:12px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
  color:var(--dsw-alias-label-primary,#1b1d22)}
.pf-card{display:flex;flex-direction:column;gap:10px;padding:14px 16px;border-radius:12px;
  background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.07));
  box-shadow:0 2px 10px rgba(20,28,45,.05)}
.pf-head{display:flex;align-items:center;gap:9px}
.pf-num{flex:none;width:20px;height:20px;border-radius:50%;display:flex;align-items:center;justify-content:center;
  font-size:11.5px;font-weight:600;color:#fff;background:var(--dsw-alias-brand-primary,#4d6bfe)}
.pf-title{font-size:13px;font-weight:600;letter-spacing:.1px}
.pf-note{margin:0;font-size:11.5px;line-height:1.62;color:var(--dsw-alias-label-secondary,#5c6270)}
.pf-mock{display:flex;flex-direction:column;gap:8px;padding:10px 12px;border-radius:9px;
  background:var(--dsw-alias-bg-base,#fff);border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.07))}
.pf-wsrow{display:flex;align-items:center;gap:7px;padding:4px 7px;border-radius:7px;font-size:11.5px;font-weight:500;
  background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}
.pf-wsico{font-size:9px;opacity:.55}
.pf-menu{display:flex;flex-direction:column;align-self:flex-start;min-width:190px;padding:5px;border-radius:8px;
  background:var(--dsw-alias-bg-layer-2,#fff);border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));
  box-shadow:0 6px 18px rgba(0,0,0,.12)}
.pf-mi{padding:3px 8px;border-radius:5px;font-size:11.5px;color:var(--dsw-alias-label-secondary,#5c6270)}
.pf-mi.dim{opacity:.35}
.pf-mi.hi{color:var(--dsw-alias-brand-primary,#4d6bfe);font-weight:600;
  background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4d6bfe) 10%,transparent)}
.pf-notice{display:flex;align-items:center;gap:8px;padding:4px 9px;border-radius:7px;font-size:11.5px;
  color:var(--dsw-alias-label-secondary,#5c6270);
  background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4d6bfe) 8%,transparent)}
.pf-cancel{margin-left:auto;flex:none;font-size:10.5px;opacity:.75}
.pf-tabs{display:flex;gap:6px}
.pf-tab{padding:2px 9px;border-radius:999px;font-size:11px;border:1px solid var(--dsw-alias-border-l2,rgba(38,49,72,.18));
  color:var(--dsw-alias-label-secondary,#5c6270)}
.pf-tab.target{outline:2px dashed color-mix(in srgb,var(--dsw-alias-brand-primary,#4d6bfe) 55%,transparent);outline-offset:1px;
  color:var(--dsw-alias-label-primary,#1b1d22);font-weight:600}
.pf-row{display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:7px;font-size:11.5px}
.pf-key{font-weight:600;color:var(--dsw-alias-link,#4d6bfe)}
.pf-sum{flex:1;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.pf-badge{flex:none;padding:1px 7px;border-radius:6px;font-size:11px;color:var(--dsw-alias-label-secondary,#5c6270);
  background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}
.pf-plan{flex:none;display:inline-flex;align-items:center;gap:4px;padding:1px 7px;border-radius:6px;font-size:11px;
  border:1px solid transparent;color:var(--dsw-alias-label-secondary,#5c6270)}
.pf-plan.on{color:var(--dsw-alias-brand-primary,#4d6bfe);border-color:var(--dsw-alias-brand-primary,#4d6bfe);
  background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4d6bfe) 8%,transparent)}
.pf-plan .pf-ico{font-size:9.5px;line-height:1}
.pf-x{flex:none;padding:0 4px;font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8f99)}
`;

function planFlowHtml(lang) {
  const copy = PLAN_FLOW[lang] ?? PLAN_FLOW.en;
  const mocks = {
    menu: `<div class="pf-mock">
      <div class="pf-wsrow"><span class="pf-wsico">▸</span><span>${copy.workspace}</span></div>
      <div class="pf-menu"><div class="pf-mi dim">⋯</div><div class="pf-mi hi">${copy.menuLink}</div><div class="pf-mi dim">⋯</div></div>
    </div>`,
    tabs: `<div class="pf-mock">
      <div class="pf-notice"><span>${copy.hint}</span><span class="pf-cancel">${copy.cancel}</span></div>
      <div class="pf-tabs"><span class="pf-tab">${copy.all}</span><span class="pf-tab target">${copy.project}</span><span class="pf-tab">${copy.other}</span></div>
    </div>`,
    row: `<div class="pf-mock">
      <div class="pf-row"><span class="pf-key">${copy.key}</span><span class="pf-sum">${copy.summary}</span>
        <span class="pf-badge">${copy.status}</span><span class="pf-plan"><span class="pf-ico">☰</span>${copy.plan}</span></div>
    </div>`,
    rowon: `<div class="pf-mock">
      <div class="pf-row"><span class="pf-key">${copy.key}</span><span class="pf-sum">${copy.summary}</span>
        <span class="pf-plan on"><span class="pf-ico">☰</span>${copy.plan}</span><span class="pf-x">×</span></div>
    </div>`,
  };
  const cards = copy.steps.map((step) => `<div class="pf-card">
      <div class="pf-head"><span class="pf-num">${step.n}</span><span class="pf-title">${step.title}</span></div>
      ${mocks[step.mock]}
      <p class="pf-note">${step.note}</p>
    </div>`).join('');
  return pageHtml('plan-flow', `<style>${PLAN_FLOW_CSS}</style><div class="pf">${cards}</div>`);
}

for (const lang of LANGS) {
  const suffix = lang === 'zh' ? '.zh' : '';

  /* --- 1) 浮层列表：干净的一屏（无未读） --- */
  if (WANTED('panel')) {
    currentEntries = {};
    transport.watchState.payload = CLEAN_WATCH;
    // 行上带 epic / 父任务的 ↳ 行（APP-300 有 4 个子项，APP-377 与 OPS-88 同属 OPS-60）。
    await openPanel(lang);
    let panel = renderPanel();
    measureRows('panel', panel, PANEL_W, PANEL_H);
    panel = renderPanel();
    shot(`panel${suffix}`, panelHtml('panel', panel), PANEL_W, PANEL_H);
  }

  /* --- 2) 实时监视横幅 + 某一行的状态流转下拉 --- */
  if (WANTED('panel-watch')) {
    // 打开 APP-412 那一行的下拉：真库量到那行变高后会把后面的行整体下移，截图里同样让位。
    currentEntries = { 'i:APP-412': 116 };
    transport.watchState.payload = CLEAN_WATCH;
    await openPanel(lang);
    transport.watchState.payload = UNREAD_WATCH;
    await settle(120);
    let panel = renderPanel();
    // 定位 APP-412 那一行里的状态徽标（行内第一个 `jmw-badge act` 就是状态下拉入口）。
    const row = rowOf(panel, 'APP-412');
    const chip = collect(row, (node) => String(node.props.className ?? '').startsWith('jmw-badge act'))[0];
    if (!chip) throw new Error('APP-412 那一行没有状态徽标');
    chip.props.onClick();
    await settle(120);
    panel = renderPanel();
    measureRows('panel-watch', panel, PANEL_W, PANEL_H);
    panel = renderPanel();
    shot(`panel-watch${suffix}`, panelHtml('panel-watch', panel), PANEL_W, PANEL_H);
  }

  /* --- 4) 整站搜索：关键词命中、按迭代分组的命中结果 --- */
  if (WANTED('panel-search')) {
    currentEntries = {};
    transport.watchState.payload = CLEAN_WATCH;
    const { commandCalls } = await openPanel(lang);
    // 真正走一遍交互：点放大镜 → 打字 → 回车（面板把草稿切成 searchText 再发 `--search=`）。
    const query = COPY[lang].search;
    let panel = renderPanel();
    const magnifier = collect(panel, (node) => String(node.props.className ?? '').includes('jmw-searchbtn'))[0];
    if (!magnifier) throw new Error('找不到搜索框的放大镜');
    magnifier.props.onClick();
    await settle(40);
    panel = renderPanel();
    const input = collect(panel, (node) => node.type === 'input')[0];
    if (!input) throw new Error('点开放大镜后没有输入框');
    input.props.onChange({ target: { value: query } });
    await settle(20);
    panel = renderPanel();
    const retyped = collect(panel, (node) => node.type === 'input')[0];
    retyped.props.onKeyDown({ key: 'Enter', isComposing: false, preventDefault() {} });
    await settle(200);
    if (!commandCalls.some((line) => line.includes(`--search=${query}`))) {
      throw new Error(`面板没有按搜索词发 --search=${query}（实际：${commandCalls.join(' | ')}）`);
    }
    panel = renderPanel();
    if (!text(panel).includes(query)) throw new Error('搜索结果的副标题里没有关键词');
    measureRows('panel-search', panel, PANEL_W, PANEL_H);
    panel = renderPanel();
    shot(`panel-search${suffix}`, panelHtml('panel-search', panel), PANEL_W, PANEL_H);
  }

  /* --- 5) 按 epic 分组：跨项目组 + 组头的「N 个项目」，另有「计划」标成 on 的两行 --- */
  if (WANTED('panel-epic')) {
    currentEntries = {};
    transport.watchState.payload = CLEAN_WATCH;
    await openPanel(lang, { plans: { 'APP-412': 'sess-stage', 'APP-377': 'sess-stage' } });
    let panel = renderPanel();
    // 按面板语言找那一颗切换按钮（按钮文字就是字典里的 groupByEpic）。
    const epicLabel = lang === 'zh' ? '按 epic' : 'By epic';
    const epicBtn = collect(panel, (node) => text(node).trim() === epicLabel && node.type === 'button')[0];
    if (!epicBtn) throw new Error('找不到「按 epic」切换按钮');
    epicBtn.props.onClick();
    await settle(60);
    panel = renderPanel();
    if (!text(panel).includes(COPY[lang].epics['OPS-60'])) throw new Error('按 epic 分组后没看到 epic 组');
    // 三个组头都要在画面里（APP-300 / OPS-60 / 无 epic 各一组）。
    const heads = collect(panel, (node) => String(node.props.className ?? '') === 'jmw-grouphead');
    if (heads.length !== 3) throw new Error(`按 epic 应该只有 3 个组头，实际 ${heads.length}`);
    measureRows('panel-epic', panel, PANEL_W, PANEL_H);
    panel = renderPanel();
    shot(`panel-epic${suffix}`, panelHtml('panel-epic', panel), PANEL_W, PANEL_H);
  }

  /* --- 6) 任务行的「计划」/「×」：整张列表按真实尺寸排好，只裁上方看得到的那几行 --- */
  if (WANTED('panel-plan')) {
    transport.watchState.payload = CLEAN_WATCH;
    await openPanel(lang, { plans: { 'APP-412': 'sess-stage', 'APP-398': 'sess-stage' } });
    measureRows('panel-plan', renderPanel(), PANEL_W, PLAN_SHOT_H);
    const panel = renderPanel();
    // APP-412 是 `☰ 计划`（on，已绑定）+ `×`；APP-450 只有 `☰ 计划`——一张图同时对比两种状态。
    const bound = rowOf(panel, 'APP-412');
    if (!collect(bound, (node) => String(node.props.className ?? '').includes('plan-drop')).length) {
      throw new Error('已绑定的行上没有「×」');
    }
    const fresh = rowOf(panel, 'APP-450');
    if (collect(fresh, (node) => String(node.props.className ?? '').includes('jmw-badge act plan')).some((node) => String(node.props.className ?? '').includes(' on'))) {
      throw new Error('没计划过的行不该是已绑定状态');
    }
    shot(`panel-plan${suffix}`, panelHtml('panel-plan', panel), PANEL_W, PLAN_SHOT_H);
  }

  /* --- 7) 「计划」四步图解（示意图）：绑定工作区 → 点计划 → 回来看绑定态 --- */
  if (WANTED('plan-flow')) {
    shot(`plan-flow${suffix}`, planFlowHtml(lang), 1040, 470);
  }
  /* --- 3) 左侧栏入口（带未读角标） --- */
  if (WANTED('sidebar-entry')) {
    transport.watchState.payload = UNREAD_WATCH;
    await loadClient(lang);
    await settle(120);
    const entry = renderEntry(true);
    const html = pageHtml('sidebar-entry', `<div class="shot"><div class="shot-rail"><div class="shot-rail-wrap">${serialize(entry)}</div></div></div>`);
    shot(`sidebar-entry${suffix}`, html, RAIL_W, RAIL_H);
  }
}

rmSync(join(SHOT_DIR, 'chrome-profile'), { recursive: true, force: true });
console.log(`done: ${LANGS.join('+')} / ${THEME} → ${OUT_DIR.replace(`${WS}/`, '')}`);
process.exit(0);
