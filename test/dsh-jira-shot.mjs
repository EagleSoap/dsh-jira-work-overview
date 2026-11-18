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
 *   sidebar-entry.png    左侧栏入口 + 未读角标
 *   zh 版本加 `.zh` 后缀
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

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
const CHROME = process.env.DSH_JIRA_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ASAR = process.env.DSH_JIRA_ASAR || '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar';
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
  },
};

/** 一条工作项，字段与 host `--json` 载荷同形（camelCase，client 直接吃）。 */
function item(lang, key, priority, status, summaryKey, sprint, extra = {}) {
  const copy = COPY[lang];
  return {
    key,
    summary: copy.summaries[summaryKey ?? key] ?? key,
    status,
    category: STATUS_CATEGORY[status] ?? 'new',
    priority,
    parent: extra.parent ?? '',
    type: 'Story',
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
    item(lang, 'APP-412', 'Highest', 'IN QA', null, S24, { due: '2026-11-20', updated: '2026-11-19' }),
    item(lang, 'APP-398', 'High', 'In Progress', null, S24, { due: '2026-11-21' }),
    item(lang, 'APP-425', 'Medium', 'To Do', null, S24),
    item(lang, 'APP-401', 'Low', 'To Do', null, S24, { due: '2026-11-16', overdue: true }),
    item(lang, 'APP-377', 'Medium', 'Done', null, S24, { updated: '2026-11-14' }),
  ];
  const s25 = [
    item(lang, 'APP-450', 'High', 'To Do', null, S25),
    item(lang, 'APP-452', 'Low', 'To Do', null, S25, { labels: ['docs'] }),
  ];
  const none = [
    item(lang, 'OPS-88', 'High', 'In Progress', null, null),
    item(lang, 'APP-463', 'Medium', 'IN QA', null, null, { updated: '2026-11-17' }),
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

const CLEAN_WATCH = { enabled: true, watchEnabled: true, watchIntervalMs: 60000, counts: { new: 0, status: 0, closed: 0, total: 0 }, changes: [] };
const UNREAD_WATCH = {
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

/* 与 visual 套件不同：这里要**真的**按条目身份给位移，因为截图上行的位置就是最终观感。
   `sizes` 允许把某一条（例如展开了状态下拉的那行）撑高，后面的行跟着下移 —— 与真库量过后的效果一致。 */
let currentEntries = [];
function makeVirtualizer(options) {
  const count = Math.max(0, Number(options?.count) || 0);
  const keys = Array.from({ length: count }, (_, index) => (options.getItemKey ? options.getItemKey(index) : index));
  const sizes = keys.map((key, index) => {
    const estimate = Number(options?.estimateSize?.(index) ?? 32) || 32;
    return Math.max(1, currentEntries[key] ?? estimate);
  });
  const starts = [];
  let total = 0;
  for (let index = 0; index < count; index += 1) {
    starts.push(total);
    total += sizes[index];
  }
  // 只渲染前 32 条：面板视口就这么高，真库也只给窗口内的行。
  const items = Array.from({ length: Math.min(count, 32) }, (_, index) => ({ index, key: keys[index], start: starts[index], size: sizes[index] }));
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

async function loadClient(lang) {
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
  const sessions = { 'sess-main': { id: 'sess-main' } };
  const payload = demoPayload(lang);

  const clientCtx = {
    get(name) {
      if (name === 'sessions') return { list: { getSnapshot: () => ({ byId: sessions }) } };
      if (name === 'remote.commands') {
        return {
          async execute() {
            await new Promise((done) => setTimeout(done, 20));
            return { ok: true, value: { commandId: 'jira', result: { kind: 'success', text: JSON.stringify(payload) } } };
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
  return { mod, payload };
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

function renderPanel() {
  currentComponent = 'Panel';
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
    '--force-color-profile=srgb', '--force-device-scale-factor=2', '--virtual-time-budget=1200',
    `--user-data-dir=${join(SHOT_DIR, 'chrome-profile')}`,
    `--window-size=${width},${height}`, `--screenshot=${png}`, `file://${base}.html`,
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

for (const lang of LANGS) {
  const suffix = lang === 'zh' ? '.zh' : '';

  /* --- 1) 浮层列表：干净的一屏（无未读） --- */
  if (WANTED('panel')) {
    currentEntries = {};
    transport.watchState.payload = CLEAN_WATCH;
    await loadClient(lang);
    const entry = renderEntry(true);
    collect(entry, (row) => row.type === 'button')[0].props.onClick();
    await settle(200);
    const panel = renderPanel();
    const html = pageHtml('panel', `<div class="shot"><div class="shot-main">${serialize(panel)}</div></div>`);
    shot(`panel${suffix}`, html, PANEL_W, PANEL_H);
  }

  /* --- 2) 实时监视横幅 + 某一行的状态流转下拉 --- */
  if (WANTED('panel-watch')) {
    // 打开 APP-412 那一行的下拉：那行会被撑高，后面的行按身份整体下移（列表 stub 按 key 给高度）。
    currentEntries = { 'i:APP-412': 116 };
    transport.watchState.payload = CLEAN_WATCH;
    await loadClient(lang);
    const entry = renderEntry(true);
    collect(entry, (row) => row.type === 'button')[0].props.onClick();
    await settle(200);
    transport.watchState.payload = UNREAD_WATCH;
    await settle(120);
    let panel = renderPanel();
    // 定位 APP-412 那一行里的状态徽标（行内第一个 `jmw-badge act` 就是状态下拉入口）。
    const row = collect(panel, (node) => String(node.props.className ?? '').split(' ')[0] === 'jmw-row')
      .find((node) => text(node).includes('APP-412'));
    if (!row) throw new Error('截图数据里找不到 APP-412 那一行');
    const chip = collect(row, (node) => String(node.props.className ?? '').startsWith('jmw-badge act'))[0];
    if (!chip) throw new Error('APP-412 那一行没有状态徽标');
    chip.props.onClick();
    await settle(120);
    panel = renderPanel();
    const html = pageHtml('panel-watch', `<div class="shot"><div class="shot-main">${serialize(panel)}</div></div>`);
    shot(`panel-watch${suffix}`, html, PANEL_W, PANEL_H);
  }

  /* --- 3) 左侧栏入口（带未读角标） --- */
  if (WANTED('sidebar-entry')) {
    currentEntries = {};
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
