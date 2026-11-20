// 离线端到端：真 host 命令 + 真 client 组件（按 sprint 分组 + 折叠/展开）。
import { copyFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/* --- 跨平台：临时目录与本机凭据文件（Windows 上用 os.tmpdir()，可用 DSH_JIRA_TMP 覆盖） --- */
const TMP = process.env.DSH_JIRA_TMP || (existsSync(join('/tmp', '.dsh_jira_env')) ? '/tmp' : tmpdir());
const HOST_COPY = join(TMP, 'dsh-jira-smoke3', 'index.js');
const ENV_FILE = process.env.DSH_JIRA_ENV_FILE || join(TMP, '.dsh_jira_env');
mkdirSync(join(TMP, 'dsh-jira-smoke3'), { recursive: true });

const WS = dirname(dirname(fileURLToPath(import.meta.url)));
copyFileSync(`${WS}/index.js`, HOST_COPY);

const env = Object.fromEntries(
  readFileSync(ENV_FILE, 'utf8')
    .split('\n')
    .filter((line) => line.includes('='))
    .map((line) => {
      const at = line.indexOf('=');
      return [line.slice(0, at).trim(), line.slice(at + 1).trim().replace(/^["']|["']$/g, '')];
    }),
);

/* ----------------------------------------------------------- 迷你 React */

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

/** 展开函数组件，得到「宿主元素」树（type 是字符串的节点）。 */
function expand(element) {
  if (element === null || element === undefined || typeof element === 'boolean') return null;
  if (typeof element === 'string' || typeof element === 'number') return { type: '#text', props: {}, children: [], text: String(element) };
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

/* ------------------------------------------------------ 虚拟列表替身 */
/* 基座模块表里 @tanstack/react-virtual 是真货；测试里给一个可配置的替身：
   - 默认（virtualState.window === null）：返回**全部条目**，于是「行数 = N / 条目数 = N」的旧断言继续成立；
   - 把 window 设成 [start, end]（或环境变量 DSH_JIRA_VIRTUAL_WINDOW=5-10）：只返回窗口内的条目，
     这时 DOM 里的 .jmw-vrow 数 = 窗口大小，但 getTotalSize()/条目总数仍是全量 ——
     这是「真的只渲染视口内的行」的唯一证据。 */
const virtualState = { window: null, options: [] };
{
  const hit = /^(\d+)-(\d+)$/.exec(String(process.env.DSH_JIRA_VIRTUAL_WINDOW ?? '').trim());
  if (hit) virtualState.window = [Number(hit[1]), Number(hit[2])];
}
function useVirtualizerStub(options) {
  // 把 client 真正传下来的选项留档：G 段直接断言 getItemKey / estimateSize 按条目身份与类型走。
  virtualState.options.push(options);
  const count = Math.max(0, Number(options?.count) || 0);
  const size = 32;
  const all = Array.from({ length: count }, (_, index) => ({ index, key: index, start: index * size, size }));
  const items = virtualState.window ? all.slice(virtualState.window[0], virtualState.window[1] + 1) : all;
  return {
    getTotalSize: () => count * size,
    getVirtualItems: () => items,
    measureElement: () => undefined,
    scrollToIndex: () => undefined,
  };
}

/* --------------------------------------------------------- 角标通道 stub */

const watchRoutes = [];
const effects = [];
const watchState = { payload: null, acked: 0, mode: 'ok' };
const jsonStub = (payload) => ({ ok: true, status: 200, async json() { return payload; } });

/* -------------------------------------------------------------- 假 DOM */

const styleTags = [];
const keyHandlers = [];
const documentStub = {
  head: { appendChild: (tag) => styleTags.push(tag) },
  body: {},
  activeElement: undefined,
  createElement: (tag) => ({
    tagName: tag, dataset: {}, style: {}, textContent: '',
    remove() { this.removed = true; },
  }),
  querySelector: (selector) => styleTags.find((tag) => selector.includes(tag.dataset.pluginCss)) ?? null,
  addEventListener(type, handler) { if (type === 'keydown') keyHandlers.push(handler); },
  removeEventListener(type, handler) {
    if (type === 'keydown') {
      const at = keyHandlers.indexOf(handler);
      if (at >= 0) keyHandlers.splice(at, 1);
    }
  },
};

Object.defineProperty(globalThis, 'document', { value: documentStub, configurable: true });
Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true });

const loaded = [];
Object.defineProperty(globalThis, 'window', {
  value: {
    __ModuleLoader__: {
      load(spec) {
        loaded.push(spec);
      },
    },
    __DSH_TRANSPORT__: {
      async fetch(url, init) {
        const method = String(init?.method ?? 'GET').toUpperCase();
        if (String(url).split('?')[0] === '/api/jira-work-overview/transition') {
          return transitionFetch(String(url), init ?? {});
        }
        if (method === 'POST') {
          watchState.acked += 1;
          // 真宿主 ack 会清空 pending，之后的 GET 自然返回 0；stub 也照做，否则轮询立刻把角标填回来。
          watchState.payload = { ...(watchState.payload ?? {}), counts: { new: 0, status: 0, closed: 0, total: 0 }, changes: [] };
          return jsonStub({ ok: true, cleared: 2, watch: watchState.payload });
        }
        // 真宿主是长轮询（最长 25s 才回），stub 也等一下：否则 await 只在微任务队列里打转，
        // 会把 setTimeout/渲染等宏任务饿死，测试直接挂住。
        await new Promise((resolve) => setTimeout(resolve, 25));
        if (watchState.mode === 'gone') return { ok: false, status: 404, async json() { return {}; } };
        return jsonStub({ ok: true, watch: watchState.payload ?? { enabled: true, counts: { new: 0, status: 0, closed: 0, total: 0 }, changes: [] }, now: new Date().toISOString() });
      },
    },
  },
  configurable: true,
});

/* ------------------------------------------------ 改状态通道 stub（离线顶替 host 写路由） */

const transitionCalls = [];
const transitionState = { fail: false, current: 'Backlog' };
const OK = (payload, status = 200) => ({ ok: status < 400, status, async json() { return payload; } });
const TRANSITIONS = [
  { id: '31', name: '正在进行', to: '正在进行', category: 'indeterminate', required: [] },
  { id: '81', name: 'IN QA', to: 'IN QA', category: 'indeterminate', required: [] },
  { id: '41', name: '完成', to: '已完成', category: 'done', required: [] },
  { id: '11', name: '待办事项列表', to: 'Backlog', category: 'new', required: [] },
];

async function transitionFetch(url, init) {
  const method = String(init.method ?? 'GET').toUpperCase();
  const key = new URL(url, 'http://dsh.invalid').searchParams.get('key') ?? 'APP-4051';
  transitionCalls.push({ method, url, body: init.body ? JSON.parse(init.body) : null });
  await new Promise((resolve) => setTimeout(resolve, 20));
  if (method === 'POST') {
    if (transitionState.fail) return OK({ ok: false, error: 'Jira 400 Bad Request：字段「解决结果」必填' }, 400);
    const body = JSON.parse(init.body);
    const row = TRANSITIONS.find((t) => t.id === String(body.transitionId));
    transitionState.current = row?.to ?? transitionState.current;
    return OK({ ok: true, key: body.key, status: row?.to ?? '', category: row?.category ?? '' });
  }
  return OK({ ok: true, key, current: transitionState.current, currentCategory: 'new', transitions: TRANSITIONS });
}


/* 站点优先级名次（GET /rest/api/3/priority 的数组下标，0 = 最高级）——host 发下来的就是这个。
   fixture 里带上它，走的就是「按 Jira 名次上底色」的主路径；H 段再单独验没有名次时的名字兜底。 */
const PRIORITY_RANK = { highest: 0, high: 1, medium: 2, low: 3, lowest: 4 };
const mkItem = (key, priority, sprint, status = 'Backlog', category = 'new', rank = PRIORITY_RANK[String(priority).toLowerCase()] ?? null) => ({
  key,
  summary: `${priority} 的活 · ${key}`,
  status,
  category,
  priority,
  priorityRank: rank,
  parent: '',
  type: '故事',
  due: '',
  overdue: false,
  updated: '2026-11-18',
  labels: [],
  url: `https://example.atlassian.net/browse/${key}`,
  sprintId: sprint ? sprint.id : null,
  sprint: sprint ? sprint.name : '',
  sprintState: sprint ? sprint.state : '',
  sprintStart: sprint ? sprint.start : '',
  sprintEnd: sprint ? sprint.end : '',
});
const S30 = { id: 30, name: 'APP Sprint 30', state: 'future', start: '2026-12-01', end: '2026-12-14' };
const S29 = { id: 29, name: 'APP Sprint 29', state: 'active', start: '2026-11-01', end: '2026-11-14' };
/* 状态筛选的选项清单，与 host 载荷的 statusOptions 同形（状态名 + statusCategory）。 */
const STATUS_OPTIONS = [
  { name: 'Backlog', category: 'new' },
  { name: 'IN QA', category: 'indeterminate' },
  { name: '已完成', category: 'done' },
];
const FIXTURE = {
  ok: true,
  source: 'dsh-jira-work-overview',
  generatedAt: '2026-11-18T08:00:00.000Z',
  query: { scope: 'all', jql: 'x' },
  project: 'APP',
  credentialSource: 'DSH 凭据库 JIRA_API_TOKEN',
  notes: [],
  counts: { new: 4, indeterminate: 2, done: 0, total: 6 },
  // 状态筛选：当前筛选（空串 = 全部）与可选状态列表。
  status: '',
  statusOptions: STATUS_OPTIONS,
  // 准确总数（不是页内条数）与每个项目的总数，供「共 N 项」断言。
  total: 123,
  projectTotals: { APP: 123 },
  items: [
    mkItem('APP-H1', 'Highest', S30, 'Backlog', 'new'),
    mkItem('APP-H2', 'High', S30, 'IN QA', 'indeterminate'),
    mkItem('APP-H3', 'Medium', S30, 'Backlog', 'new'),
    mkItem('APP-H4', 'Highest', S29, 'Backlog', 'new'),
    mkItem('APP-H5', 'Low', null, 'Backlog', 'new'),
    mkItem('APP-H6', 'High', null, 'IN QA', 'indeterminate'),
  ],
  sprints: [
    { id: 30, name: S30.name, state: S30.state, start: S30.start, end: S30.end, active: false, keys: ['APP-H1', 'APP-H2', 'APP-H3'], counts: { new: 2, indeterminate: 1, done: 0, total: 3 } },
    { id: 29, name: S29.name, state: S29.state, start: S29.start, end: S29.end, active: true, keys: ['APP-H4'], counts: { new: 1, indeterminate: 0, done: 0, total: 1 } },
    { id: null, name: '无迭代', state: '', start: '', end: '', active: false, keys: ['APP-H5', 'APP-H6'], counts: { new: 1, indeterminate: 1, done: 0, total: 2 } },
  ],
};

/* 虚拟列表用的大 fixture：400 行，分 3 组（3 个组头 + 400 行 = 403 个一维条目），
   验证「DOM 里只有视口内的行、占位容器高度是全量」。 */
const bigItems = Array.from({ length: 400 }, (_, index) => {
  const n = index + 1;
  return mkItem(`APP-B${n}`, n % 2 ? 'High' : 'Medium', n % 3 === 1 ? S30 : (n % 3 === 2 ? S29 : null));
});
const bigGroup = (sprint, id) => {
  const keys = bigItems.filter((item) => item.sprintId === id).map((item) => item.key);
  return {
    id,
    name: sprint ? sprint.name : '无迭代',
    state: sprint ? sprint.state : '',
    start: sprint ? sprint.start : '',
    end: sprint ? sprint.end : '',
    active: Boolean(sprint && sprint.state === 'active'),
    keys,
    counts: { new: keys.length, indeterminate: 0, done: 0, total: keys.length },
  };
};
const BIG_FIXTURE = {
  ...FIXTURE,
  counts: { new: 400, indeterminate: 0, done: 0, total: 400 },
  total: 400,
  projectTotals: { APP: 400 },
  items: bigItems,
  sprints: [bigGroup(S30, 30), bigGroup(S29, 29), bigGroup(null, null)],
};

/* 搜索 fixture：两条结果分属一个迭代 + 无迭代，用来验「搜索结果也按迭代分组」。 */
const S28 = { id: 28, name: 'APP Sprint 28', state: 'future', start: '2026-12-15', end: '2026-12-28' };
const SEARCH_ITEMS = [
  mkItem('APP-S1', 'High', S28, 'Backlog', 'new'),
  mkItem('APP-S2', 'Low', null, 'IN QA', 'indeterminate'),
];
const SEARCH_FIXTURE = {
  ...FIXTURE,
  query: { scope: 'search', jql: 'text ~ "網上APP" ORDER BY updated DESC', search: '網上APP' },
  items: SEARCH_ITEMS,
  sprints: [
    { id: 28, name: S28.name, state: S28.state, start: S28.start, end: S28.end, active: false, keys: ['APP-S1'], counts: { new: 1, indeterminate: 0, done: 0, total: 1 } },
    { id: null, name: '无迭代', state: '', start: '', end: '', active: false, keys: ['APP-S2'], counts: { new: 0, indeterminate: 1, done: 0, total: 1 } },
  ],
  total: 2,
  projectTotals: { APP: 2 },
  counts: { new: 1, indeterminate: 1, done: 0, total: 2 },
};

/* --------------------------------------------------------- host 半边 */

const store = new Map();
const CRED = ['creden', 'tials'].join('');
const hostTools = new Map();
const hostCommands = [];
const credentials = {
  async resolve(key) {
    return store.has(key) ? { value: store.get(key), source: 'store' } : undefined;
  },
  async set(key, value) {
    store.set(key, value);
  },
};
const hostCtx = {
  get(name) {
    if (name === CRED) return credentials;
    if (name === 'commands') {
      return { register(definition) { hostCommands.push(definition); return () => {}; } };
    }
    if (name === 'connection') {
      return { fetch: { register(route) { watchRoutes.push(route); return async () => {}; } } };
    }
    return undefined;
  },
  tools: { register(definition) { hostTools.set(definition.name, definition); } },
};

const host = await import(pathToFileURL(HOST_COPY).href);
host.apply(hostCtx, {
  baseUrl: env.JIRA_BASE_URL,
  email: env.JIRA_EMAIL,
  apiToken: env.JIRA_API_TOKEN,
  projectKey: 'APP',
  boardId: 42,
  maxResults: 50,
  timeoutMs: 30000,
});
const hostCommand = hostCommands.find((row) => row.name === 'jira');
console.log('host: tools =', [...hostTools.keys()].join(','), '| commands =', hostCommands.map((row) => row.name).join(','));

/* --------------------------------------------------------- client 半边 */

const calls = [];
const completed = [];
const slotRegistrations = [];
let sessionRows = { 'sess-main': { id: 'sess-main', retainedBy: { mainView: 1 } } };

/* 命令桩：记录命令，并按 `--status=` 过滤 fixture（status 名字可能带空格，例如 IN QA）。 */
const activeFixture = { current: FIXTURE };
/* 失败桩：非 null 时命令返回 host 的 ok:false 载荷（error.code 决定面板给哪种提示）。 */
const activeFailure = { current: null };
const failurePayload = ({ code, message }) => ({
  ok: false,
  error: { code, message },
  query: { scope: 'all', jql: '' },
  items: [],
  sprints: [],
  statusOptions: [],
  notes: [],
  status: '',
  total: null,
  hasMore: false,
  limit: 0,
});
const statusOf = (line) => {
  const hit = /--status=(.*?)(?=\s--\w|$)/.exec(String(line));
  return hit ? hit[1].trim() : '';
};
const searchOf = (line) => {
  const hit = /--search=(.*)$/.exec(String(line));
  return hit ? hit[1].trim() : '';
};
const payloadFor = (line) => {
  // 搜索是另一批结果（host 侧由 text ~ / key = 决定），面板只负责把它按迭代分组显示出来。
  const search = searchOf(line);
  if (search) return SEARCH_FIXTURE;
  const status = statusOf(line);
  const base = activeFixture.current;
  if (!status) return { ...base, status: '' };
  const items = base.items.filter((item) => item.status === status);
  return {
    ...base,
    status,
    items,
    counts: { new: 0, indeterminate: 0, done: 0, total: items.length },
    total: items.length,
    projectTotals: items.length ? { APP: items.length } : {},
    sprints: [],
  };
};

const clientCtx = {
  get(name) {
    if (name === 'sessions') return { list: { getSnapshot: () => ({ byId: sessionRows }) } };
    if (name === 'remote.commands') {
      return {
        // 固定 payload：只验视觉与分组，不联网（Jira 只是数据源，不该决定这些断言能不能跑）
        async execute(sessionId, line) {
          calls.push({ sessionId, line });
          completed.push(line);
          if (activeFailure.current) {
            return { ok: true, value: { commandId: 'jira', result: { kind: 'success', text: JSON.stringify(failurePayload(activeFailure.current)) } } };
          }
          return { ok: true, value: { commandId: 'jira', result: { kind: 'success', text: JSON.stringify(payloadFor(line)) } } };
        },
      };
    }
    return undefined;
  },
  effect(fn) { const off = fn(); effects.push(off); return () => {}; },
  slots: {
    inject(name, factory) { factory(); },
    register(options, component) { slotRegistrations.push({ options, component }); return () => {}; },
  },
};

await import(pathToFileURL(`${WS}/client.js`).href);
const spec = loaded[0];
if (!spec) throw new Error('client.js 没有调用 window.__ModuleLoader__.load');
const mod = spec.factory((name) => {
  if (name === 'react') return React;
  if (name === 'react-dom') return { createPortal: (node) => node };
  if (name === '@tanstack/react-virtual') return { useVirtualizer: useVirtualizerStub };
  return undefined;
});
mod.apply(clientCtx);

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => {
  for (let i = 0; i < 120 && completed.length < calls.length; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await tick();
  await tick();
};

console.log('client module id:', spec.id);
console.log('style 标记:', styleTags.map((tag) => tag.dataset.pluginCss).join(',') || '（未注入）');
console.log('inject:', JSON.stringify(mod.inject));
console.log('槽注册:', slotRegistrations.map((row) => `${row.options.name}#${row.options.id}`).join(', '));

const entryComponent = slotRegistrations.find((row) => row.options.id === 'jira-work-overview').component;
const panelComponent = slotRegistrations.find((row) => row.options.id === 'jira-work-overview-panel').component;

function renderEntry(wide) {
  currentComponent = 'Entry';
  hookIndex = 0;
  return expand(createElement(entryComponent, { wide }));
}

function renderPanel() {
  currentComponent = 'Panel';
  hookIndex = 0;
  return expand(createElement(panelComponent, {}));
}

function groupHeads(tree) {
  return collect(tree, (row) => row.type === 'button' && row.props.className === 'jmw-grouphead');
}

function rows(tree) {
  return collect(tree, (row) => String(row.props.className ?? '').split(' ')[0] === 'jmw-row');
}

function statusButtons(tree) {
  return collect(tree, (row) => row.type === 'button' && String(row.props.className ?? '').startsWith('jmw-badge act'));
}

function menuChips(tree) {
  return collect(tree, (row) => row.type === 'button' && String(row.props.className ?? '').startsWith('jmw-chip pick'));
}

/* 断言计数器提到最前面：优先级高亮（H 段）在后面几段之前就要用。 */
let failed = 0;
const check = (ok, label, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : ` | ${detail}`}`);
  if (!ok) failed += 1;
};

const entry = renderEntry(true);
collect(entry, (row) => row.type === 'button')[0].props.onClick();
await settle();
let panel = renderPanel();

const heads = groupHeads(panel);
console.log('组头:', heads.map((head) => text(head).replace(/\s+/g, ' ').trim()).join(' | '));
console.log('组头里有「进行中」吗:', heads.some((head) => text(head).includes('进行中')));
console.log('组头里有「未开始/已结束」吗:', heads.some((head) => /未开始|已结束/.test(text(head))));

const rowInfo = rows(panel).map((row) => {
  const cls = String(row.props.className ?? '');
  const level = cls.includes('pri-highest') ? 'highest' : (cls.includes('pri-high') ? 'high' : 'none');
  const keyNode = collect(row, (r) => String(r.props.className ?? '') === 'jmw-key')[0];
  const badges = collect(row, (r) => String(r.props.className ?? '').startsWith('jmw-badge pri'));
  return { key: keyNode ? text(keyNode).trim() : '?', level, badge: badges.map((b) => `${text(b).trim()}:${b.props.className}`).join('') };
});
console.log('行（按显示顺序）：');
for (const row of rowInfo) console.log('  ·', row.key, '→', row.level, row.badge ? `[${row.badge}]` : '');

const expected = ['APP-H1:highest', 'APP-H2:high', 'APP-H3:none', 'APP-H4:highest', 'APP-H5:none', 'APP-H6:high'];
const actual = rowInfo.map((row) => `${row.key}:${row.level}`);
console.log('\n优先级高亮符合预期:', JSON.stringify(actual) === JSON.stringify(expected), '|', actual.join(' '));
check(
  JSON.stringify(actual) === JSON.stringify(expected),
  'H 名次驱动的高亮（0 红 / 1 琥珀 / 其余不上色）',
  actual.join(' '),
);
console.log('组内顺序符合预期(30 → 29 → 无迭代):', heads.map((h) => text(h).trim().slice(0, 13)).join(' | '));
console.log('迭代区间那一行（S29 已过期应提示）:', collect(panel, (row) => String(row.props.className ?? '') === 'jmw-meta-line').map((row) => text(row).replace(/\s+/g, ' ').trim()).join(' / '));
const pillTexts = collect(panel, (row) => String(row.props.className ?? '').split(' ')[0] === 'jmw-pill').map((row) => text(row).trim());
console.log('项目 tab 文案（不应带数字）:', JSON.stringify(pillTexts), '| 有数字吗:', /\d/.test(pillTexts.join('')));

/* ---------------- A：范围分段控件与旧工具条整行都没了 ---------------- */
const byClass = (root, name) => collect(root, (row) => String(row.props.className ?? '').split(' ')[0] === name);
const subtitleText = () => text(collect(panel, (row) => String(row.props.className ?? '') === 'jmw-sub')[0]).replace(/\s+/g, ' ').trim();
console.log('\nA .jmw-seg 节点数:', byClass(panel, 'jmw-seg').length, '（期望 0）| .jmw-bar 节点数:', byClass(panel, 'jmw-bar').length, '（期望 0）| .jmw-total 节点数:', byClass(panel, 'jmw-total').length, '（期望 0）');
console.log('A 「未完成 / 当前迭代」按钮数:', collect(panel, (row) => row.type === 'button' && ['未完成', '当前迭代'].includes(text(row).trim())).length, '（期望 0）');
console.log('A 面板首条命令（范围固定 all、条数固定 0 = 不限制）:', calls[0]?.line);

/* ---------------- C：标题下的统计 = 筛选后的准确总数 ---------------- */
console.log('C 副标题:', JSON.stringify(subtitleText()), '（期望「共 123 项」）');
const ftuPill = collect(panel, (row) => row.type === 'button' && String(row.props.className ?? '').split(' ')[0] === 'jmw-pill' && text(row).trim() === 'APP')[0];
ftuPill.props.onClick();
panel = renderPanel();
console.log('C 切到 APP 后副标题（projectTotals.APP=123）:', JSON.stringify(subtitleText()));
const allPill = collect(panel, (row) => row.type === 'button' && String(row.props.className ?? '').split(' ')[0] === 'jmw-pill' && text(row).trim() === '全部项目')[0];
allPill.props.onClick();
panel = renderPanel();

/* ---------------- B：tab 行右侧的状态筛选（单选，默认全部） ---------------- */
const filterBtn = () => collect(panel, (row) => row.type === 'button' && String(row.props.className ?? '').split(' ')[0] === 'jmw-filterbtn')[0];
console.log('\nB tab 行右侧有筛选按钮:', Boolean(filterBtn()), '| 文案:', JSON.stringify(text(filterBtn()).trim()));
filterBtn().props.onClick();
panel = renderPanel();
console.log('B 打开筛选菜单 chips:', JSON.stringify(menuChips(panel).map((chip) => text(chip).trim())));
console.log('B 菜单结构 .jmw-menu / .jmw-menu-chips:', byClass(panel, 'jmw-menu').length, '/', collect(panel, (row) => String(row.props.className ?? '') === 'jmw-menu-chips').length);
const qaChip = menuChips(panel).find((chip) => text(chip).trim().startsWith('IN QA'));
qaChip.props.onClick({ preventDefault() {} });
await settle();
panel = renderPanel();
const lastLine = calls[calls.length - 1]?.line ?? '';
console.log('B 点「IN QA」后的命令:', lastLine);
console.log('B 命令里含 --status=IN QA:', /--status=IN QA(\s|$)/.test(lastLine));
console.log('B 菜单已关闭:', byClass(panel, 'jmw-menu').length === 0);
console.log('B 筛选后副标题:', JSON.stringify(subtitleText()), '| 行数:', rows(panel).length, '（fixture 里 IN QA 有 2 条）');
console.log('B 按钮显示当前状态名:', JSON.stringify(text(filterBtn()).trim()));

/* Esc 关筛选菜单（与状态下拉同一层） */
filterBtn().props.onClick();
panel = renderPanel();
const hadMenu = byClass(panel, 'jmw-menu').length;
keyHandlers[keyHandlers.length - 1]({ key: 'Escape', preventDefault() {} });
panel = renderPanel();
console.log('B Esc 关筛选菜单:', hadMenu === 1, '→', byClass(panel, 'jmw-menu').length === 0);

/* ---------------- E：虚拟列表（3 组头 + 400 行 = 403 个一维条目） ---------------- */
const ENTRY_TOTAL = 403;
const ROW_SIZE = 32;
activeFixture.current = BIG_FIXTURE;
filterBtn().props.onClick();
panel = renderPanel();
menuChips(panel).find((chip) => text(chip).trim().startsWith('全部状态')).props.onClick({ preventDefault() {} });
await settle();
panel = renderPanel();

const vlistOf = () => collect(panel, (row) => String(row.props.className ?? '') === 'jmw-vlist')[0];
const vrowsOf = () => collect(panel, (row) => String(row.props.className ?? '') === 'jmw-vrow');
const totalHeight = () => vlistOf()?.props?.style?.height;
const headOf = (name) => groupHeads(panel).find((head) => text(head).includes(name));
const pickStatus = async (label) => {
  filterBtn().props.onClick();
  panel = renderPanel();
  menuChips(panel).find((chip) => text(chip).trim().startsWith(label)).props.onClick({ preventDefault() {} });
  await settle();
  panel = renderPanel();
};

console.log('\nE 条目总数（3 组头 + 400 行）:', ENTRY_TOTAL, '| .jmw-vlist 占位高:', totalHeight(), `（期望 ${ENTRY_TOTAL * ROW_SIZE} = 条目数 × ${ROW_SIZE}）`);
console.log('E 替身默认给全部条目 → DOM 任务行数:', rows(panel).length, '（期望 400）| DOM 条目数 .jmw-vrow:', vrowsOf().length, '（期望 403）');
const firstVrow = vrowsOf()[0];
console.log('E 每行挂 ref + data-index + translateY(start):', Boolean(firstVrow?.props?.ref), '/', firstVrow?.props?.['data-index'], '/', firstVrow?.props?.style?.transform);
console.log('E 渐进式渲染残留 .jmw-rendering 节点数:', collect(panel, (row) => String(row.props.className ?? '') === 'jmw-rendering').length, '（期望 0）');

/* 只给窗口 [5,10] 的条目：DOM 里只剩 6 个条目，但占位容器高度仍是全量 —— 真的只画视口内。 */
virtualState.window = [5, 10];
panel = renderPanel();
const windowRows = vrowsOf();
console.log('E 窗口 [5,10] → DOM 条目数:', windowRows.length, '（期望 6 = 窗口大小）| DOM 任务行数:', rows(panel).length, '| .jmw-vlist 占位高:', totalHeight(), `（仍应为 ${ENTRY_TOTAL * ROW_SIZE}）`);
console.log('E 窗口内条目的 data-index@translateY:', windowRows.map((row) => `${row.props['data-index']}@${row.props.style.transform}`).join(' '));
virtualState.window = null;
panel = renderPanel();

/* 折叠 S30（134 条）：折叠的组只产出组头，条目数/总高都要跟着重算。 */
headOf('Sprint 30').props.onClick();
panel = renderPanel();
const collapsedTotal = ENTRY_TOTAL - 134;
console.log('E 折叠 S30(134 条) 后条目数:', vrowsOf().length, `（期望 ${collapsedTotal}）`, '| 占位高:', totalHeight(), `（期望 ${collapsedTotal * ROW_SIZE}）`, '| DOM 行数:', rows(panel).length, '（期望 266）| 组头仍在:', groupHeads(panel).length);
headOf('Sprint 30').props.onClick();
panel = renderPanel();
console.log('E 再展开 S30 后条目数:', vrowsOf().length, '（期望 403）| 占位高:', totalHeight(), `（期望 ${ENTRY_TOTAL * ROW_SIZE}）`);

/* 状态筛选（BIG fixture 全是默认状态，IN QA 命中 0 条）→ 条目序列只剩空态一行。 */
await pickStatus('IN QA');
console.log('E 状态筛选 IN QA 后条目数:', vrowsOf().length, '（期望 1 = 只有空态）| 占位高:', totalHeight(), `（期望 ${ROW_SIZE}）| 空态文案:`, JSON.stringify(text(vrowsOf()[0]).trim()));
console.log('E 筛选命令:', calls[calls.length - 1]?.line);
await pickStatus('全部状态');
console.log('E 回到全部状态后条目数:', vrowsOf().length, '（期望 403）| 占位高:', totalHeight(), `（期望 ${ENTRY_TOTAL * ROW_SIZE}）`);

/* 切项目 tab：不能再有任何「分批画」的残留，一帧就是全量条目。 */
collect(panel, (row) => row.type === 'button' && String(row.props.className ?? '').split(' ')[0] === 'jmw-pill' && text(row).trim() === 'APP')[0].props.onClick();
panel = renderPanel();
console.log('E 切项目 tab 后 DOM 条目数:', vrowsOf().length, '（期望 403，无分批残留）| 占位高:', totalHeight(), `（期望 ${ENTRY_TOTAL * ROW_SIZE}）`);

console.log('状态徽标按钮数:', statusButtons(panel).length, '| 页脚:', text(collect(panel, (row) => String(row.props.className ?? '') === 'jmw-foot')[0]).replace(/\s+/g, ' ').trim());

/* ---------------- G：虚拟列表的条目身份与估算（2026-11-19 修的两处） ----------------
   `@tanstack/react-virtual` 的默认 getItemKey 是 `index => index`（defaultKeyExtractor），实测高度按
   **下标**缓存。折叠 / 展开会让同一串下标换成完全不同的条目：折叠前 index 1 是任务行（约 32px），
   折叠后 index 1 变成第二个组头（约 64px）—— 按下标复用旧高度，组头就被压在一起，「日期和标题」
   错位（用户实际报的「折叠全部后样式错误」）。estimateSize 也必须按条目类型分开，否则滚动中每量到
   一个组头整列就往下窜一截。这里把 client 交给 useVirtualizer 的选项抓下来，把这两件事钉死。
   （`check` / `failed` 在文件前面声明，H 段与本段共用。） */

/* 整屏遮罩不许再出现 backdrop-filter：整窗大小的 backdrop-filter 在 macOS + Electron 上滚动重绘时
   会让整屏闪一下（用户报的「滚动列表时屏幕闪烁」）。遮罩本身只压暗、不模糊。
   注释里会提到这个词，所以先把 CSS 注释剥掉再查声明。 */
const css = styleTags.map((tag) => tag.textContent ?? '').join('\n');
const cssBody = css.replace(/\/\*[\s\S]*?\*\//g, '');
// 模糊只能出现在搜索框上、而且只能用 DSH 菜单的 token；整屏遮罩依旧一律禁止
//（整窗 backdrop-filter 在 macOS + Electron 滚动重绘时会让整屏闪 —— 0.13.3 的回归）。
const blurDecls = cssBody.match(/backdrop-filter[^;}]*/g) ?? [];
check(
  blurDecls.length > 0
  && blurDecls.every((decl) => decl.includes('var(--dsw-menu-backdrop-filter'))
  && !/\.jmw-(?:mask|credmask)\{{[^}}]*backdrop-filter/.test(cssBody),
  'G 只有搜索框用平台菜单的毛玻璃 token，两处整屏遮罩仍不带 blur',
  blurDecls.join(' / ') || '无',
);
check(
  /\.jmw-mask\{[^}]*background:var\(--dsw-alias-bg-mask-1/.test(css) && /\.jmw-credmask\{[^}]*background:var\(--dsw-alias-bg-mask-1/.test(css),
  'G 两处遮罩仍然压暗（只是去掉了模糊）',
);

panel = renderPanel();
const expandedOptions = virtualState.options.at(-1);
const keyOf = (options, index) => (typeof options?.getItemKey === 'function' ? options.getItemKey(index) : undefined);
const estimateOf = (options, index) => (typeof options?.estimateSize === 'function' ? options.estimateSize(index) : NaN);
const keysExpanded = Array.from({ length: expandedOptions?.count ?? 0 }, (_, index) => keyOf(expandedOptions, index));
const groupKeysExpanded = keysExpanded.filter((key) => String(key).startsWith('g:'));
check(typeof expandedOptions?.getItemKey === 'function', 'G 交给 useVirtualizer 的 getItemKey 存在（库默认 index => index）');
check(
  estimateOf(expandedOptions, 0) > estimateOf(expandedOptions, 1),
  'G estimateSize 按条目类型分开（组头 > 任务行）',
  `组头 ${estimateOf(expandedOptions, 0)} / 任务行 ${estimateOf(expandedOptions, 1)}`,
);
check(
  String(keyOf(expandedOptions, 0)).startsWith('g:') && String(keyOf(expandedOptions, 1)).startsWith('i:'),
  'G 展开态条目 key 是 g:组 / i:任务 的身份 key',
  `${keyOf(expandedOptions, 0)} / ${keyOf(expandedOptions, 1)}`,
);
console.log('G 展开态 条目数/组头数:', expandedOptions?.count, '/', groupKeysExpanded.length, '| 前 4 个 key:', JSON.stringify(keysExpanded.slice(0, 4)));

/* 点「折叠全部」：条目序列从 (3 组头 + 400 行) 变成 3 个组头，下标 1 的身份必然换人。 */
const collapseAllBtn = collect(panel, (row) => row.type === 'button' && String(row.props.className ?? '') === 'jmw-linkbtn')[0];
check(text(collapseAllBtn).trim() === '折叠全部', 'G tab 行右侧的按钮当前是「折叠全部」', JSON.stringify(text(collapseAllBtn).trim()));
collapseAllBtn.props.onClick();
panel = renderPanel();
const collapsedOptions = virtualState.options.at(-1);
const keysCollapsed = Array.from({ length: collapsedOptions?.count ?? 0 }, (_, index) => keyOf(collapsedOptions, index));
check(
  collapsedOptions?.count === groupKeysExpanded.length,
  'G 折叠全部后条目数 = 组头数',
  `${collapsedOptions?.count} vs ${groupKeysExpanded.length}`,
);
check(
  keysCollapsed.every((key) => String(key).startsWith('g:')),
  'G 折叠全部后每个条目都是组头 key',
  JSON.stringify(keysCollapsed),
);
check(
  keysCollapsed.every((key) => keysExpanded.includes(key)),
  'G 折叠后每个 key 在展开态都存在（高度按身份复用，不会串位）',
  keysCollapsed.join(', '),
);
check(
  keysExpanded[1] !== keysCollapsed[1],
  'G 下标 1 的身份确实变了（按下标缓存就是这次错位的成因）',
  `${keysExpanded[1]} → ${keysCollapsed[1]}`,
);
check(
  estimateOf(collapsedOptions, 1) > estimateOf(expandedOptions, 1),
  'G 折叠后下标 1 按组头估算（不再套任务行的 32）',
  `${estimateOf(collapsedOptions, 1)} vs ${estimateOf(expandedOptions, 1)}`,
);
/* 复原：这时按钮是「展开全部」，点回去，别把后面的 F 段留在折叠态。 */
collect(panel, (row) => row.type === 'button' && String(row.props.className ?? '') === 'jmw-linkbtn')[0].props.onClick();
panel = renderPanel();
check(
  (virtualState.options.at(-1)?.count ?? 0) === expandedOptions?.count,
  'G 再点「展开全部」条目数复原',
  `${virtualState.options.at(-1)?.count} vs ${expandedOptions?.count}`,
);

/* ---------------- H：高亮挂在 Jira 给的优先级名次上（2026-11-19） ----------------
   host 把 GET /rest/api/3/priority 的数组下标当 priorityRank 发下来（0 = Jira 里的最高级），
   client 上底色只看它。下面这份 fixture 的名字全都不叫 Highest/High（Blocker / P0 / P1 …）：
   按名字判断一个都不该上色，按名次判断才拿得到 0 红、1 琥珀。 */
const RENAMED = ['Blocker', 'P0', 'P1', 'P2', 'P3', 'P4'];
const levelsOf = () => rows(panel).map((row) => {
  const cls = String(row.props.className ?? '');
  const keyNode = collect(row, (r) => String(r.props.className ?? '') === 'jmw-key')[0];
  return `${keyNode ? text(keyNode).trim() : '?'}:${cls.includes('pri-highest') ? 'highest' : (cls.includes('pri-high') ? 'high' : 'none')}`;
});
const expectedLevels = ['APP-H1:highest', 'APP-H2:high', 'APP-H3:none', 'APP-H4:highest', 'APP-H5:none', 'APP-H6:high'];

activeFixture.current = {
  ...FIXTURE,
  items: FIXTURE.items.map((item, index) => ({ ...item, priority: RENAMED[index], priorityRank: index })),
};
/* 面板只在首次挂载或显式操作时拉数据：用和 E 段一样的手法（状态筛选 → 全部状态）触发一次 load。 */
await pickStatus('全部状态');
const renamedLevels = levelsOf();
check(
  JSON.stringify(renamedLevels) === JSON.stringify(['APP-H1:highest', 'APP-H2:high', 'APP-H3:none', 'APP-H4:none', 'APP-H5:none', 'APP-H6:none']),
  'H 自定义名字（Blocker / P0 / …）也按名次上色（名次 0 红、1 琥珀，其余不上色）',
  renamedLevels.join(' '),
);
const renamedBadges = rows(panel).map((row) => collect(row, (r) => String(r.props.className ?? '').startsWith('jmw-badge pri'))
  .map((b) => `${text(b).trim()}:${String(b.props.className).replace('jmw-badge pri', '').trim()}`).join(''));
check(
  renamedBadges[0] === 'Blocker:highest' && renamedBadges[1] === 'P0:high' && !renamedBadges[2],
  'H 名次 0 的徽标用 highest 配色、名次 1 用 high（文案是 Jira 的原话）；名次 2 起不挂徽标',
  `${renamedBadges[0]} / ${renamedBadges[1]} / ${renamedBadges[2] || '无'}`,
);

/* 没有名次（旧载荷 / 站点给不出这个接口）仍然按名字兜底，不能因为改挂钩就丢掉老行为。 */
activeFixture.current = { ...FIXTURE, items: FIXTURE.items.map(({ priorityRank, ...rest }) => rest) };
await pickStatus('全部状态');
const fallbackLevels = levelsOf();
check(
  JSON.stringify(fallbackLevels) === JSON.stringify(expectedLevels),
  'H 载荷里没有 priorityRank 时退回按名字判断（Highest / High 照旧高亮）',
  fallbackLevels.join(' '),
);
activeFixture.current = FIXTURE;
await pickStatus('全部状态');

/* ---------------- I：可分类的失败 → 提示文字（不是原始报错） ----------------
   host 在 --json 失败时回 ok:false + error.code；面板按 code 选文案，「去配置」直达令牌弹窗，
   原始 message 只在 detail 类里以小字附上（无令牌这类「一句话能解决」的不该甩一坨报错）。 */
const clsOf = (row) => String(row.props?.className ?? '');
const failureNode = (name) => collect(panel, (row) => clsOf(row) === name)[0];
const failTitle = () => text(failureNode('jmw-failure-title')).trim();
const failHint = () => text(failureNode('jmw-failure-hint')).trim();
const failDetails = () => collect(panel, (row) => clsOf(row) === 'jmw-failure-detail');
const failButtons = () => collect(panel, (row) => clsOf(row).split(' ')[0] === 'jmw-btn').map((row) => text(row).trim());
const refreshBtn = () => collect(panel, (row) => row.type === 'button' && row.props?.['aria-label'] === '刷新')[0];

activeFailure.current = { code: 'no_credential', message: 'Missing Jira credential: put JIRA_API_TOKEN into the DSH credential store…' };
refreshBtn().props.onClick();
await settle();
panel = renderPanel();
console.log('\nI 没配令牌：标题 =', JSON.stringify(failTitle()), '| 提示 =', JSON.stringify(failHint()), '| 按钮 =', JSON.stringify(failButtons()), '| 原始报错可见 =', failDetails().length);
check(
  failTitle() === '还没有配置 Jira 令牌'
  && failHint().includes('Jira API token')
  && failButtons().includes('去配置')
  && failButtons().includes('重试')
  && failDetails().length === 0,
  'I 无令牌 → 提示文字 + 去配置 / 重试，且不显示原始报错',
  `${failTitle()} / ${failButtons().join(',')}`,
);
const openConfig = collect(panel, (row) => clsOf(row).split(' ')[0] === 'jmw-btn' && text(row).trim() === '去配置')[0];
openConfig.props.onClick();
panel = renderPanel();
check(
  collect(panel, (row) => clsOf(row) === 'jmw-credmodal').length === 1,
  'I 「去配置」直接打开令牌弹窗',
  `jmw-credmodal=${collect(panel, (row) => clsOf(row) === 'jmw-credmodal').length}`,
);
keyHandlers[keyHandlers.length - 1]({ key: 'Escape', preventDefault() {} });
panel = renderPanel();

/* detail 类（站点 / 网络）：提示之外要能看见原始 message，否则用户没法判断到底哪儿错了。 */
activeFailure.current = { code: 'auth', message: 'Jira 401 Unauthorized (/rest/api/3/search/jql)：Check your email and API token' };
refreshBtn().props.onClick();
await settle();
panel = renderPanel();
console.log('I 401：标题 =', JSON.stringify(failTitle()), '| 详情小字 =', JSON.stringify(text(failDetails()[0]).trim().slice(0, 40)));
check(
  failTitle() === 'Jira 不认这组邮箱 / 令牌' && failDetails().length === 1 && text(failDetails()[0]).includes('401'),
  'I 401 → 「邮箱 / 令牌不被接受」+ 原始信息收在详情里',
  failTitle(),
);
const retryBtn = collect(panel, (row) => clsOf(row).split(' ')[0] === 'jmw-btn' && text(row).trim() === '重试')[0];
activeFailure.current = null;
retryBtn.props.onClick();
await settle();
panel = renderPanel();
check(
  rows(panel).length > 0 && collect(panel, (row) => clsOf(row) === 'jmw-failure').length === 0,
  'I 恢复后点重试 → 回到正常列表（失败态被清掉）',
  `rows=${rows(panel).length}`,
);

/* ---------------- J：改状态 = 就地更新，不全量重拉；并把这次流转的 from/to 捎给 host ----------------
   一次 `/jira --json all --limit=0` 会把几百条 issue 重新翻页拉一遍，而改一个状态真正变的只有
   status / statusCategory / 计数。这里钉住：状态徽标点了之后**没有**新的 /jira 命令，界面却已更新，
   同时 POST 里带上 from / to / 分类（host 用它让后台轮询认出「这是自己改的」，不再弹通知）。 */
const waitMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
transitionState.current = 'Backlog';
transitionState.fail = false;
transitionState.current = 'Backlog';
activeFixture.current = FIXTURE;
await pickStatus('全部状态');
panel = renderPanel();

const rowOf = (key) => rows(panel).find((row) => text(collect(row, (r) => String(r.props.className ?? '') === 'jmw-key')[0]).trim() === key);
const statusText = (key) => text(statusButtons(rowOf(key))[0]).trim();
const dotClassOf = (key) => String(collect(rowOf(key), (r) => String(r.props.className ?? '').split(' ')[0] === 'jmw-dot')[0]?.props?.className ?? '');
const groupHeadText = (needle) => text(groupHeads(panel).find((head) => text(head).includes(needle))).replace(/\s+/g, ' ').trim();
const flashText = () => text(byClass(panel, 'jmw-flash')[0]).trim();

async function pickTransition(key, label) {
  transitionCalls.length = 0;
  statusButtons(rowOf(key))[0].props.onClick({ preventDefault() {}, stopPropagation() {} });
  // 流转清单是异步拉的：chips 要等那一次 GET 回来、面板重渲染之后才存在。
  let chips = [];
  for (let i = 0; i < 80 && chips.length === 0; i += 1) {
    await waitMs(20);
    panel = renderPanel();
    chips = menuChips(panel);
  }
  const chip = chips.find((row) => text(row).trim().startsWith(label));
  if (!chip) throw new Error(`没找到流转 chip：${label} / ${JSON.stringify(chips.map((row) => text(row).trim()))}`);
  chip.props.onClick({ preventDefault() {}, stopPropagation() {} });
  // 等 POST 回来、面板把这一行改完（下拉关掉、busy 清掉）。
  for (let i = 0; i < 80; i += 1) {
    await waitMs(20);
    panel = renderPanel();
    if (transitionCalls.some((call) => call.method === 'POST') && menuChips(panel).length === 0) break;
  }
  await waitMs(40);
  panel = renderPanel();
}

const sprint30Before = groupHeadText('Sprint 30');
const commandsBefore = calls.length;
await pickTransition('APP-H2', '已完成');
const postBody = transitionCalls.find((call) => call.method === 'POST')?.body;
check(calls.length === commandsBefore, 'J 改状态后不再全量重拉列表（没有新的 /jira 命令）', `${commandsBefore} → ${calls.length} 条命令`);
check(
  postBody?.from === 'Backlog' && postBody?.to === '已完成' && postBody?.category === 'done',
  'J POST 捎带 from / to / 分类（host 靠这对值认出「自己改的」，轮询不再通知）',
  JSON.stringify(postBody),
);
check(statusText('APP-H2').startsWith('已完成'), 'J 行内状态徽标就地变成新状态', statusText('APP-H2'));
check(dotClassOf('APP-H2') === 'jmw-dot done', 'J 行首圆点按新分类上色（done 绿）', dotClassOf('APP-H2'));
check(
  sprint30Before.includes('未完成 3 / 共 3') && groupHeadText('Sprint 30').includes('未完成 2 / 共 3'),
  'J 组头的未完成数就地重算（3/3 → 2/3）',
  `${sprint30Before} → ${groupHeadText('Sprint 30')}`,
);
check(/APP-H2\s*已改为\s*已完成/.test(flashText()) || flashText().includes('APP-H2'), 'J 顶部一次性提示仍然给', flashText());

/* 新状态并入筛选菜单：fixture 的 statusOptions 里没有「正在进行」，本地更新要把它补进去并保持排序。 */
await pickTransition('APP-H1', '正在进行');
filterBtn().props.onClick();
panel = renderPanel();
const optionTexts = menuChips(panel).map((chip) => text(chip).replace('✓', '').trim());
check(
  JSON.stringify(optionTexts) === JSON.stringify(['全部状态', 'Backlog', 'IN QA', '正在进行', '已完成']),
  'J 新状态并入状态筛选菜单，并按「分类 → 名字」排序',
  JSON.stringify(optionTexts),
);
filterBtn().props.onClick();
panel = renderPanel();

/* 状态筛选开着时改到别的状态：跟重新查询一样，这条要从列表消失，总数也要减。 */
await pickStatus('Backlog');
panel = renderPanel();
const filteredBefore = rows(panel).length;
const subtitleBefore = subtitleText();
const totalBefore = Number((subtitleBefore.match(/共\s*(\d+)\s*项/) ?? [])[1]);
const filterCommandsBefore = calls.length;
await pickTransition('APP-H1', '已完成');
check(
  rows(panel).length === filteredBefore - 1 && calls.length === filterCommandsBefore,
  'J 状态筛选开着时改到别的状态：该行就地消失（不重拉列表）',
  `${filteredBefore} → ${rows(panel).length} 行 / 命令 ${filterCommandsBefore} → ${calls.length}`,
);
check(
  Number.isFinite(totalBefore) && subtitleText() === `共 ${totalBefore - 1} 项 · 状态 Backlog`,
  'J 副标题的准确总数跟着减 1',
  `${JSON.stringify(subtitleBefore)} → ${JSON.stringify(subtitleText())}`,
);
activeFixture.current = FIXTURE;
await pickStatus('全部状态');
panel = renderPanel();

/* ---------------- K：搜索（放大镜 → 输入 → 回车搜整站；结果同样按迭代分组） ----------------
   和 Jira 的搜索框一致：关键词搜整站（不只我的 issue），issue key / 浏览链接直达那一条；
   结果复用同一套「迭代分组 + 项目 tab + 状态筛选」。这里钉住 client 的接线：
   展开输入行、受控输入、回车才发查询、`--search=` 放行尾、清除回我的列表、Esc 只收输入行。 */
const searchBtnOf = () => collect(panel, (row) => row.type === 'button' && String(row.props.className ?? '').includes('jmw-searchbtn'))[0];
const searchInputOf = () => collect(panel, (row) => row.type === 'input' && String(row.props.className ?? '') === 'jmw-searchinput')[0];
const searchClearOf = () => collect(panel, (row) => row.type === 'button' && String(row.props.className ?? '') === 'jmw-searchclear')[0];
const lastCommand = () => calls[calls.length - 1]?.line ?? '';
const rowKeys = () => rows(panel).map((row) => text(collect(row, (r) => String(r.props.className ?? '') === 'jmw-key')[0]).trim());

const searchWrapOf = () => collect(panel, (row) => String(row.props.className ?? '').includes('jmw-searchexpand'))[0];
const searchOpenNow = () => String(searchWrapOf()?.props.className ?? '').includes('open');
const headerNodeOf = () => collect(panel, (row) => String(row.props.className ?? '') === 'jmw-head')[0];
const inSearchBox = (cls) => collect(searchBoxOf(), (row) => String(row.props.className ?? '').includes(cls)).length;
const searchBoxOf = () => collect(panel, (row) => String(row.props.className ?? '') === 'jmw-searchbox')[0];

check(Boolean(searchBtnOf()), 'K 标题栏有搜索按钮');
check(!collect(panel, (row) => String(row.props.className ?? '') === 'jmw-search').length, 'K 搜索框就在按钮位置（不再单开一行）');
check(
  collect(headerNodeOf(), (row) => String(row.props.className ?? '').includes('jmw-searchexpand')).length === 1,
  'K 搜索容器挂在标题栏里',
);
check(!searchOpenNow() && searchInputOf()?.props.tabIndex === -1, 'K 默认收起：只看得到放大镜按钮（输入框不可聚焦）');
// 展开 / 收起必须是宽度过渡（右边缘固定 → 视觉上向左长出来、向右缩回按钮）。
check(
  /\.jmw-searchexpand\{[^}]*transition:width/.test(css)
  && /\.jmw-searchexpand\.open\{[^}]*width:/.test(css)
  && /\.jmw-searchbox\{[^}]*transition:width/.test(css),
  'K 展开 / 收起有宽度过渡（向左展开、收回按钮）',
);
// 收起的输入框盖在按钮上（z-index 更高），必须 pointer-events:none，否则点击被它吃掉、
// 放大镜像「点不动」——真机上就是这么坏的，mini DOM 拦不住，所以在这里钉 CSS。
check(
  /\.jmw-searchbox\{[^}]*pointer-events:none/.test(css)
  && /\.jmw-searchexpand\.open \.jmw-searchbox\{[^}]*pointer-events:auto/.test(css),
  'K 收起的输入框不吃点击（按钮可点），展开后才接管',
);
// 收起时必须先缩宽、最后才淡出：原来 opacity 和 width 同时跑，160ms 就透明了，
// 视觉上像「瞬间消失」。这里钉住收起态 opacity 有延迟、展开态无延迟。
check(
  /\.jmw-searchbox\{[^}]*transition:[^}]*opacity\s+\.1s\s+ease\s+\.16s/.test(css)
  && /\.jmw-searchexpand\.open \.jmw-searchbox\{[^}]*opacity\s+\.08s\s+ease/.test(css),
  'K 收起时先缩宽再淡出（不是瞬间消失）',
);

searchBtnOf().props.onClick();
panel = renderPanel();
check(searchOpenNow() && Boolean(searchInputOf()), 'K 点按钮后在按钮原位展开输入框');
// 输入框是毛玻璃框体，放大镜画在框内左侧、输入框与清除按钮也都在框内（不是图标挂框外）。
check(
  Boolean(searchBoxOf()) && inSearchBox('jmw-searchicon') === 1 && inSearchBox('jmw-searchinput') === 1,
  'K 搜索图标与输入框在同一个框体内',
  `box=${Boolean(searchBoxOf())} icon=${inSearchBox('jmw-searchicon')} input=${inSearchBox('jmw-searchinput')}`,
);
check(searchInputOf().props.value === '', 'K 首次展开输入框为空', JSON.stringify(searchInputOf().props.value));
searchInputOf().props.onChange({ target: { value: '網上APP' } });
panel = renderPanel();
check(searchInputOf().props.value === '網上APP', 'K 输入框受控（草稿不自动发查询）');
check(calls.length === commandsBefore || !lastCommand().includes('--search='), 'K 只改草稿不发查询', lastCommand());
searchInputOf().props.onKeyDown({ key: 'Enter' });
await settle();
panel = renderPanel();
check(/--search=網上APP$/.test(lastCommand()), 'K 回车后发 --search=（放行尾，整段词不丢）', lastCommand());
check(searchInputOf().props.value === '', 'K 执行搜索后清空输入框', JSON.stringify(searchInputOf().props.value));
check(JSON.stringify(rowKeys()) === JSON.stringify(['APP-S1', 'APP-S2']), 'K 搜索结果显示对应任务项', rowKeys().join(','));
check(groupHeads(panel).some((head) => text(head).includes('APP Sprint 28')), 'K 搜索结果按迭代分组（显示对应迭代）', groupHeads(panel).map((head) => text(head).replace(/\s+/g, ' ').trim()).join(' | '));
check(subtitleText().includes('搜索：網上APP'), 'K 副标题显示当前搜索词', subtitleText());
check(Boolean(searchClearOf()) && inSearchBox('jmw-searchclear') === 1, 'K 搜索中显示清除按钮（也在框内右侧）', `clear=${inSearchBox('jmw-searchclear')}`);

// 没执行的草稿：失焦收起后还在，再点开能接着改。
searchInputOf().props.onChange({ target: { value: '草稿ABC' } });
panel = renderPanel();
searchWrapOf().props.onBlur({ relatedTarget: null });
panel = renderPanel();
check(!searchOpenNow() && searchInputOf()?.props.tabIndex === -1, 'K 失焦后收起变回按钮（输入框不可聚焦）', `open=${searchOpenNow()} tabIndex=${searchInputOf()?.props.tabIndex}`);
check(rows(panel).length === 2, 'K 收起时已生效的搜索结果不丢', `rows=${rows(panel).length}`);
searchBtnOf().props.onClick();
panel = renderPanel();
check(searchInputOf()?.props.value === '草稿ABC', 'K 没执行的输入在收起后保留', JSON.stringify(searchInputOf()?.props.value));
keyHandlers[keyHandlers.length - 1]({ key: 'Escape', preventDefault() {} });
panel = renderPanel();
check(!searchOpenNow() && rows(panel).length === 2, 'K Esc 只收起输入框，结果不丢', `rows=${rows(panel).length}`);

// 清除：清空生效词并回到我的工作（输入框也一起清掉、收起）。
searchBtnOf().props.onClick();
panel = renderPanel();
searchClearOf().props.onClick();
await settle();
panel = renderPanel();
check(!lastCommand().includes('--search='), 'K 清除后回到我的工作列表（不再带 --search=）', lastCommand());
check(rows(panel).length === FIXTURE.items.length, 'K 清除后行数回到我的工作列表', `${rows(panel).length} vs ${FIXTURE.items.length}`);
check(!searchOpenNow() && (searchInputOf()?.props.value ?? '') === '', 'K 清除后收起按钮、输入框清空', `open=${searchOpenNow()} value=${JSON.stringify(searchInputOf()?.props.value)}`);

// 执行过搜索再展开：输入框不会把生效词回填（「执行搜索了清空输入框」）。
searchBtnOf().props.onClick();
panel = renderPanel();
check(searchInputOf()?.props.value === '', 'K 执行搜索后再次展开仍是空输入框', JSON.stringify(searchInputOf()?.props.value));
keyHandlers[keyHandlers.length - 1]({ key: 'Escape', preventDefault() {} });
panel = renderPanel();

/* ---------------- F：兜底（基座模块表里没有 @tanstack/react-virtual） ----------------
   client 在 factory 里 try/catch 地 require 它；这里再开一个模块实例、这次的 require 口故意不给它，
   验证：不崩、退回「直接渲染全部行」、并 console.warn 一次。 */
const fallbackWarns = [];
const prevWarn = console.warn;
console.warn = (...args) => { fallbackWarns.push(args.map((arg) => String(arg)).join(' ')); };
let fallbackPanel = null;
try {
  const modNoVirtual = spec.factory((name) => {
    if (name === 'react') return React;
    if (name === 'react-dom') return { createPortal: (node) => node };
    return undefined;
  });
  modNoVirtual.apply(clientCtx);
  // 按插槽名取：会话行上的角标 / hover 也用同一个 id，光按 id 会取错组件。
  const lastEntry = slotRegistrations.filter((row) => row.options.name === 'sidebar.footer.action').at(-1).component;
  const lastPanel = slotRegistrations.filter((row) => row.options.name === 'shell.overlay').at(-1).component;
  currentComponent = 'Entry';
  hookIndex = 0;
  collect(expand(createElement(lastEntry, { wide: true })), (row) => row.type === 'button')[0].props.onClick();
  await settle();
  currentComponent = 'Panel';
  hookIndex = 0;
  fallbackPanel = expand(createElement(lastPanel, {}));
} catch (error) {
  console.log('F 兜底渲染抛错了:', String(error?.message ?? error));
} finally {
  console.warn = prevWarn;
}
const fbTree = fallbackPanel ?? [];
const fbRows = collect(fbTree, (row) => String(row.props?.className ?? '').split(' ')[0] === 'jmw-row');
const fbVrows = collect(fbTree, (row) => String(row.props?.className ?? '') === 'jmw-vrow');
console.log('\nF 兜底（拿不到 @tanstack/react-virtual）：warn 次数 =', fallbackWarns.filter((line) => line.includes('react-virtual')).length,
  '（期望 1）| DOM 任务行数 =', fbRows.length, '（期望 400 = 全部行都直接画出来）| DOM 条目数 =', fbVrows.length,
  '| 占位高 =', collect(fbTree, (row) => String(row.props?.className ?? '') === 'jmw-vlist')[0]?.props?.style?.height);

for (const off of effects) { try { off?.(); } catch { /* ignore */ } }
console.log(failed === 0 ? '\n=== visual G/H/I/J/K 段（条目身份 / 估算 / 优先级名次 / 失败提示 / 改状态就地更新 / 搜索）：全部通过 ===' : `\n=== visual G/H/I/J/K 段（条目身份 / 估算 / 优先级名次 / 失败提示 / 改状态就地更新 / 搜索）：${failed} 项失败 ===`);
console.log('done');
process.exit(failed === 0 ? 0 : 1);
