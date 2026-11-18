// 离线端到端：真 host 命令 + 真 client 组件（按 sprint 分组 + 折叠/展开）。
import { copyFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/* --- 跨平台：临时目录与本机凭据文件（Windows 上用 os.tmpdir()，可用 DSH_JIRA_TMP 覆盖） --- */
const TMP = process.env.DSH_JIRA_TMP || (existsSync(join('/tmp', '.dsh_jira_env')) ? '/tmp' : tmpdir());
const HOST_COPY = join(TMP, 'dsh-jira-smoke3', 'index.js');
const ENV_FILE = process.env.DSH_JIRA_ENV_FILE || join(TMP, '.dsh_jira_env');
mkdirSync(join(TMP, 'dsh-jira-smoke3'), { recursive: true });

const WS = '/path/to/Project/dsh plugins/dsh-jira-work-overview';
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
        transportUrls.push(String(url));
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

// 这个测试的列表数据来自「真 host 命令 → 真 Jira」。外网抖动时（今天已抖过多次）拿不到 items，
// 后面的断言会连锁失败——所以先探一次：不可达就明确跳过，而不是把环境问题伪装成回归。
const preflight = await hostCommand.handler({ commandId: 'jira', rawInput: '--json --lang=zh', attachments: [], signal: undefined });
let preflightItems = 0;
try {
  if (typeof preflight?.text === 'string' && preflight.text.trimStart().startsWith('{')) {
    preflightItems = (JSON.parse(preflight.text).items ?? []).length;
  }
} catch { /* 解析不了就当不可达 */ }
if (preflightItems === 0) {
  console.log('SKIP: Jira 不可达或返回空（preflight 用 --json 探过）——', String(preflight?.text ?? preflight).replace(/\s+/g, ' ').slice(0, 140));
  console.log('      跳过依赖真数据的面板断言；离线断言看 test/dsh-jira-visual.mjs（渲染/分组/高亮）与 test/dsh-jira-i18n.mjs（语言/路由）。');
  process.exit(0);
}
{
  const pre = JSON.parse(preflight.text);
  console.log('preflight: 真 Jira 返回', preflightItems, '条 | total =', pre.total,
    '| projectTotals =', JSON.stringify(pre.projectTotals),
    '| projects =', JSON.stringify((pre.projects ?? []).map((row) => row.name)));
}

/* --------------------------------------------------------- client 半边 */

const calls = [];
const completed = [];
const transportUrls = [];
let commandDelayMs = 0;
let forceHasMore = false;
const slotRegistrations = [];
let sessionRows = { 'sess-main': { id: 'sess-main', retainedBy: { mainView: 1 } } };

const clientCtx = {
  get(name) {
    if (name === 'sessions') return { list: { getSnapshot: () => ({ byId: sessionRows }) } };
    if (name === 'remote.commands') {
      return {
        async execute(sessionId, line, attachments, signal) {
          const entry = { sessionId, line, attachments, signal };
          calls.push(entry);
          try {
            if (commandDelayMs > 0) {
              await new Promise((resolve, reject) => {
                const timer = setTimeout(resolve, commandDelayMs);
                if (signal) {
                  signal.addEventListener('abort', () => {
                    clearTimeout(timer);
                    entry.aborted = true;
                    reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }));
                  }, { once: true });
                }
              });
            }
            if (signal?.aborted) {
              entry.aborted = true;
              throw Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
            }
            const outcome = await hostCommand.handler({
              commandId: 'jira', rawInput: line.replace(/^\/jira\s*/, ''), attachments, signal,
            });
            if (typeof outcome?.text === 'string' && outcome.text.trimStart().startsWith('{')) {
              try {
                const payload = JSON.parse(outcome.text);
                if (Array.isArray(payload.items)) {
                  if (extraItems.length > 0) {
                    payload.items = [...payload.items, ...extraItems];
                    payload.counts = { ...payload.counts, total: payload.items.length };
                  }
                  // 伪造「还有更多」：用于验证「加载更多」按钮与 --limit 透传
                  if (forceHasMore) {
                    payload.hasMore = true;
                    payload.limit = payload.limit ?? 50;
                  } else {
                    payload.hasMore = false;
                  }
                  outcome.text = JSON.stringify(payload);
                }
              } catch { /* 不是 JSON 就不动 */ }
            }
            return { ok: true, value: { commandId: 'jira', result: outcome } };
          } finally {
            completed.push(line);
          }
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
/* 虚拟列表替身（基座模块表里 @tanstack/react-virtual 是真货）：默认返回**全部条目**，
   于是「行数 = N」这类既有断言继续成立；只给窗口内条目的裁剪行为在 visual 测试里单独验证。 */
function useVirtualizerStub(options) {
  const count = Math.max(0, Number(options?.count) || 0);
  const size = 32;
  const items = Array.from({ length: count }, (_, index) => ({ index, key: index, start: index * size, size }));
  return {
    getTotalSize: () => count * size,
    getVirtualItems: () => items,
    measureElement: () => undefined,
    scrollToIndex: () => undefined,
  };
}

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
const cssText = styleTags.map((tag) => tag.textContent ?? tag.innerHTML ?? '').join('\n');
console.log('弹窗样式在位:', ['jmw-credmask{position:fixed', 'jmw-credmodal{', 'jmw-btn.ghost{'].every((needle) => cssText.includes(needle)),
  '| 遮罩居中:', cssText.includes('display:flex;align-items:center;justify-content:center'));
console.log('inject:', JSON.stringify(mod.inject));
console.log('槽注册:', slotRegistrations.map((row) => `${row.options.name}#${row.options.id}`).join(', '));

let extraItems = [];
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

console.log('\n入口(wide):', text(renderEntry(true)).trim());
console.log('入口(窄)文案节点:', JSON.stringify(text(renderEntry(false)).trim()));

// 点入口 → 打开并加载
const entry = renderEntry(true);
collect(entry, (row) => row.type === 'button')[0].props.onClick();
await settle();

let panel = renderPanel();
console.log('\n打开后命令:', JSON.stringify(calls.map((row) => row.line)));
// 面板把当前语言捎给 host 的两种方式：命令行的 `--lang=`（要与 host 的 i18n 同步发布）与路由的 `?lang=`。
console.log('命令参数:', [...new Set(calls.flatMap((row) => row.line.match(/--[a-z-]+(=[^\s]+)?/g) ?? []))].join(' '),
  '| 路由参数:', [...new Set(transportUrls.map((u) => u.match(/[?&]lang=[^&]+/)?.[0]).filter(Boolean))].join(' '));
console.log('分组数:', groupHeads(panel).length);
for (const head of groupHeads(panel)) console.log('  ·', text(head).replace(/\s+/g, ' ').trim());
console.log('可见行数(默认):', rows(panel).length);
const vlistMain = collect(panel, (row) => String(row.props?.className ?? '') === 'jmw-vlist')[0];
const vrowsMain = collect(panel, (row) => String(row.props?.className ?? '') === 'jmw-vrow');
console.log('虚拟列表占位高:', vlistMain?.props?.style?.height, '| 一维条目数 .jmw-vrow:', vrowsMain.length,
  '（= 组头 + 行；替身默认给全部条目）| 组头 + 行 =', groupHeads(panel).length + '+' + rows(panel).length);
console.log('可见行:', rows(panel).map((row) => text(row).replace(/\s+/g, ' ').trim()).join(' || '));

// 折叠「进行中」那一组
const heads = groupHeads(panel);
heads[0].props.onClick();
panel = renderPanel();
console.log('\n折叠第一组后：可见行数 =', rows(panel).length, '| 第一组 aria-expanded =', groupHeads(panel)[0].props['aria-expanded']);

// 展开全部 / 折叠全部
const toolbarButtons = collect(panel, (row) => row.type === 'button' && row.props.className === 'jmw-linkbtn');
console.log('工具条按钮文案:', text(toolbarButtons[0]).trim());
toolbarButtons[0].props.onClick();
panel = renderPanel();
console.log('点它之后：可见行数 =', rows(panel).length, '| 按钮文案 =', text(collect(panel, (row) => row.type === 'button' && row.props.className === 'jmw-linkbtn')[0]).trim());
collect(panel, (row) => row.type === 'button' && row.props.className === 'jmw-linkbtn')[0].props.onClick();
panel = renderPanel();
console.log('再点一次：可见行数 =', rows(panel).length);

// 范围分段控件（未完成 / 全部）与旧工具条整行已删（用户 2026-11-18）：范围固定 all，
// 筛选移到 tab 行右侧，「展开全部 / 折叠全部」也从第二行挪到 tab 行。
const classNameOf = (row) => String(row.props?.className ?? '');
const findButton = (tree, label) => collect(tree, (row) => row.type === 'button' && text(row).trim() === label)[0];
const findByLabel = (tree, label) => collect(tree, (row) => row.type === 'button' && row.props?.['aria-label'] === label)[0];
const filterButton = (tree) => collect(tree, (row) => row.type === 'button' && classNameOf(row).split(' ')[0] === 'jmw-filterbtn')[0];
// 面板固定 all，需要「重新查一次」时只剩标题栏的刷新按钮（原来靠点「全部」范围按钮）。
const reload = async () => { findByLabel(renderPanel(), '刷新').props.onClick(); await settle(); };

const segLabels = collect(panel, (row) => row.type === 'button')
  .map((b) => text(b).trim())
  .filter((label) => ['未完成', '全部', '当前迭代'].includes(label));
console.log('\n旧范围按钮残留:', segLabels.join(' / ') || '（无）');
console.log('.jmw-seg 节点数:', collect(panel, (row) => classNameOf(row) === 'jmw-seg').length,
  '（期望 0）| .jmw-bar:', collect(panel, (row) => classNameOf(row) === 'jmw-bar').length,
  '（期望 0）| .jmw-total:', collect(panel, (row) => classNameOf(row) === 'jmw-total').length, '（期望 0）');
console.log('tab 行右侧有筛选按钮:', filterButton(panel) !== undefined, '| 文案:', JSON.stringify(text(filterButton(panel)).trim()));
console.log('副标题（共 N 项）:', JSON.stringify(text(collect(panel, (row) => classNameOf(row) === 'jmw-sub')[0]).replace(/\s+/g, ' ').trim()));

// 状态筛选：打开菜单 → 选项 = 全部状态 + payload.statusOptions，点一项重查
filterButton(panel).props.onClick();
panel = renderPanel();
console.log('筛选菜单 chips:', JSON.stringify(menuChips(panel).map((chip) => text(chip).trim())));
const pickChip = menuChips(panel)[1];
const pickedName = pickChip === undefined ? '' : text(pickChip).trim().replace(/\s*✓$/, '');
if (pickChip !== undefined) {
  pickChip.props.onClick({ preventDefault() {} });
  await settle();
  panel = renderPanel();
  console.log('点状态筛选', JSON.stringify(pickedName), '→ 命令:', JSON.stringify(calls[calls.length - 1].line),
    '| 带 --status=:', new RegExp(`--status=${pickedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`).test(calls[calls.length - 1].line),
    '| 菜单已关:', collect(panel, (row) => classNameOf(row) === 'jmw-menu').length === 0);
  console.log('筛选后副标题:', JSON.stringify(text(collect(panel, (row) => classNameOf(row) === 'jmw-sub')[0]).replace(/\s+/g, ' ').trim()),
    '| 按钮文案:', JSON.stringify(text(filterButton(panel)).trim()));
  // 切回「全部状态」，后面的断言仍然面对全量列表
  filterButton(panel).props.onClick();
  panel = renderPanel();
  const allChip = menuChips(panel)[0];
  allChip.props.onClick({ preventDefault() {} });
  await settle();
  panel = renderPanel();
}

// 标题右侧的「配置」按钮 → 用独立弹窗展示令牌设置
const credToggle = findButton(panel, '配置');
console.log('标题右侧有「配置」按钮:', credToggle !== undefined);
if (credToggle !== undefined) {
  credToggle.props.onClick();
  const opened = renderPanel();
  const modal = collect(opened, (row) => classNameOf(row) === 'jmw-credmodal')[0];
  console.log('点开后出现令牌弹窗:', collect(opened, (row) => classNameOf(row) === 'jmw-credmask').length === 1, '| 弹窗卡片:', modal !== undefined,
    '| 有密码输入框:', collect(opened, (row) => row.type === 'input' && row.props?.type === 'password').length > 0,
    '| 有保存按钮:', findButton(opened, '保存并验证') !== undefined);
  const modalClose = modal === undefined ? [] : collect(modal, (row) => row.type === 'button' && classNameOf(row) === 'jmw-iconbtn');
  console.log('弹窗内有关闭按钮:', modalClose.length === 1);
  const primaryBtn = findButton(opened, '保存并验证');
  console.log('主按钮内联色:', JSON.stringify({ background: primaryBtn?.props?.style?.background, color: primaryBtn?.props?.style?.color }),
    '| 不是主题品牌色（深色主题会变白底白字）:', primaryBtn?.props?.style?.background === '#4d6bfe');
  if (modalClose.length === 1) modalClose[0].props.onClick();
  const closed = renderPanel();
  console.log('关闭后弹窗消失:', collect(closed, (row) => classNameOf(row) === 'jmw-credmask').length === 0,
    '| 面板仍在:', collect(closed, (row) => classNameOf(row) === 'jmw-card').length === 1);

  // Esc 的第一层：只收令牌弹窗，不关面板
  findButton(renderPanel(), '配置').props.onClick();
  renderPanel();
  const escEvent = { key: 'Escape', defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  for (const handler of keyHandlers) handler(escEvent);
  const afterEsc = renderPanel();
  console.log('Esc 一次只收令牌弹窗:', collect(afterEsc, (row) => classNameOf(row) === 'jmw-credmask').length === 0,
    '| 面板仍在:', collect(afterEsc, (row) => classNameOf(row) === 'jmw-card').length === 1);
}

// 重新查一次（范围固定 all），并采集分组头（这块的变量被后面的断言用到）
await reload();
panel = renderPanel();
const allGroups = collect(panel, (row) => classNameOf(row) === 'jmw-grouphead');
console.log('\n全部范围：命令 =', JSON.stringify(calls[calls.length - 1].line));
console.log('分组数 =', allGroups.length, '| 默认可见行数 =', rows(panel).length, '| 默认折叠的分组数 =', allGroups.filter((g) => g.props['aria-expanded'] === 'false').length);
console.log('分组概览:', allGroups.map((head) => text(head).replace(/\s+/g, ' ').trim()).join(' | '));

// 多项目：tab 条列出各项目，点某个项目就只留那个项目的任务
extraItems = [{
  key: 'CRM-88', project: 'CRM', summary: 'CRM 测试项', status: 'Backlog', category: 'new', type: '故事',
  priority: 'High', parent: '', due: '', overdue: false, updated: '2026-11-18', labels: [],
  sprintId: null, sprint: '', sprintState: '', sprintStart: '', sprintEnd: '',
  url: 'https://example.atlassian.net/browse/CRM-88',
}];
await reload();
// `settle()` 只等到「命令完成」，数据落到 state 还可能差一拍；注入的 CRM 项要真的出现在
// tab 条上再往下断言，否则会偶发地拿到上一轮（只有 APP）的列表。
let withProjects = renderPanel();
for (let i = 0; i < 40; i += 1) {
  const seen = collect(withProjects, (row) => row.type === 'button' && classNameOf(row).startsWith('jmw-pill'));
  if (seen.some((pill) => text(pill).replace(/\s+/g, '').startsWith('CRM'))) break;
  await new Promise((resolve) => setTimeout(resolve, 50));
  withProjects = renderPanel();
}
const pills = collect(withProjects, (row) => row.type === 'button' && classNameOf(row).startsWith('jmw-pill'));
const pillText = (pill) => text(pill).replace(/\s+/g, '');
console.log('项目 tab:', pills.map(pillText).join(' '));
console.log('左右滚动按钮:', collect(withProjects, (row) => classNameOf(row) === 'jmw-scrollbtn').length === 2,
  '| 默认选中全部项目:', pills[0]?.props?.['aria-pressed'] === 'true');
const crmPill = pills.find((pill) => pillText(pill).startsWith('CRM'));
crmPill.props.onClick();
withProjects = renderPanel();
const crmRows = collect(withProjects, (row) => classNameOf(row).split(' ')[0] === 'jmw-row');
console.log('切到 CRM:', crmRows.length === 1, '| 只剩 CRM 的 issue:', crmRows.every((row) => text(row).includes('CRM-88')),
  '| 分组:', collect(withProjects, (row) => classNameOf(row) === 'jmw-grouphead').map((row) => text(row).slice(0, 6)).join(','));
extraItems = [];
await reload();
console.log('切回全部:', collect(renderPanel(), (row) => classNameOf(row).split(' ')[0] === 'jmw-row').length);

// 「加载更多」：面板固定要 --limit=0（不限制，取到没有下一页为止），所以只有撞到 host 的安全上限
// （5000 条 / 50 页 / 30s）才会 hasMore。这里伪造 hasMore，验证：块出现、按钮禁用（上限已经顶到底、
// 抬不上去）、页脚如实说「已达安全上限 5000 条，还有更多」而不是假装取完了。
forceHasMore = true;
await reload();
let morePanel = renderPanel();
const moreBlock = collect(morePanel, (row) => classNameOf(row) === 'jmw-more')[0];
const moreBtn = moreBlock === undefined ? undefined : collect(moreBlock, (row) => row.type === 'button')[0];
console.log('\n「加载更多」块:', moreBlock !== undefined, '| 按钮禁用:', moreBtn?.props?.disabled === true, '| 按钮文案:', text(moreBtn).trim(),
  '| 页脚:', text(collect(morePanel, (row) => classNameOf(row) === 'jmw-foot')[0]).replace(/\s+/g, ' ').trim().slice(0, 100));
const beforeMore = calls.length;
moreBtn.props.onClick();
await settle();
console.log('点（已禁用的）「加载更多」→ 新发命令数:', calls.length - beforeMore, '（期望 0：面板固定 --limit=0，这里没有再抬上限的余地）',
  '| 行数:', collect(renderPanel(), (row) => classNameOf(row).split(' ')[0] === 'jmw-row').length);
forceHasMore = false;

// 关面板要连所有浮层一起关：再点开入口时只应该有任务列表
findButton(renderPanel(), '配置').props.onClick();
renderPanel();
const panelClose = collect(renderPanel(), (row) => row.type === 'button' && row.props?.['aria-label'] === '关闭')[0];
panelClose.props.onClick();
const afterClose = renderPanel();
console.log('关面板后浮层全收:', collect(afterClose, (row) => classNameOf(row) === 'jmw-credmask').length === 0);
renderEntry(false).props.onClick();
const reopened = renderPanel();
console.log('再点开只有任务列表:', collect(reopened, (row) => classNameOf(row) === 'jmw-credmask').length === 0,
  '| 卡片在:', collect(reopened, (row) => classNameOf(row) === 'jmw-card').length === 1);

// 无会话：点刷新
sessionRows = {};
const refreshBtn = collect(panel, (row) => row.type === 'button' && row.props['aria-label'] === '刷新')[0];
refreshBtn.props.onClick();
await settle();
panel = renderPanel();
console.log('\n无会话时的提示:', text(panel).replace(/\s+/g, ' ').trim().slice(0, 150));

// 恢复会话，关掉再打开
sessionRows = { 'sess-main': { id: 'sess-main', retainedBy: { mainView: 1 } } };
collect(panel, (row) => row.type === 'button' && row.props['aria-label'] === '关闭')[0].props.onClick();
console.log('关闭后 renderPanel =', renderPanel());
const entry2 = renderEntry(true);
collect(entry2, (row) => row.type === 'button')[0].props.onClick();
await settle();
panel = renderPanel();
console.log('重新打开：命令 =', JSON.stringify(calls[calls.length - 1].line), '| 可见行数 =', rows(panel).length);


/* ------------------------------------------------------ 实时监视 */

console.log('\n=== 实时监视 ===');
console.log('客户端每条路由都带了 ?lang=:', transportUrls.filter((u) => u.startsWith('/api/')).every((u) => /[?&]lang=(zh|en)\b/.test(u)),
  '| 采样:', transportUrls.filter((u) => u.startsWith('/api/')).slice(0, 3).join(' , '));
console.log('host 注册的精确路由:', watchRoutes.map((r) => `${r.path} [${r.methods.join(',')}] ${r.requestBody}`).join(', ') || '（无）');
const route = watchRoutes[0];
if (!route) throw new Error('host 没有注册 /api/jira-work-overview/state');
const getRes = await route.fetch(new Request('http://dsh.invalid/api/jira-work-overview/state'));
const getBody = await getRes.json();
console.log('GET:', getRes.status, JSON.stringify({ enabled: getBody.watch.enabled, intervalMs: getBody.watch.intervalMs, checks: getBody.watch.checks, baseline: getBody.watch.baseline, counts: getBody.watch.counts }));
const postRes = await route.fetch(new Request('http://dsh.invalid/api/jira-work-overview/state', { method: 'POST' }));
console.log('POST 标记已读:', postRes.status, JSON.stringify(await postRes.json()));

watchState.payload = {
  enabled: true, intervalMs: 60000, checks: 3, failures: 0, lastError: '', baseline: true,
  checkedAt: '2026-11-18T07:30:00.000Z', lastChangeAt: '2026-11-18T07:29:00.000Z',
  counts: { new: 1, status: 1, closed: 0, total: 2 },
  changes: [
    { kind: 'status', key: 'APP-4018', from: 'In Review', to: 'IN QA', at: '2026-11-18T07:29:00.000Z' },
    { kind: 'new', key: 'APP-9999', summary: '新指派的工作', status: 'Backlog', at: '2026-11-18T07:28:00.000Z' },
  ],
};
await new Promise((r) => setTimeout(r, 300));
const entryTree = renderEntry(true);
const badge = collect(entryTree, (row) => row.props?.className === 'jmw-entry-badge');
console.log('入口角标:', badge.length ? text(badge[0]).trim() : '（无）');
console.log('入口 title:', JSON.stringify(collect(entryTree, (row) => row.type === 'button')[0].props.title));
panel = renderPanel();
const banner = collect(panel, (row) => row.props?.className === 'jmw-watch')[0];
console.log('面板横幅:', banner ? text(banner).replace(/\s+/g, ' ').trim() : '（无）');
const foot = collect(panel, (row) => row.props?.className === 'jmw-foot')[0];
const footText = foot ? text(foot).replace(/\s+/g, ' ').trim() : '（无）';
console.log('页脚:', footText);
// 面板固定 --limit=0，所以条数口径必须是「已加载 N 条（全部）」，不能再出现「（上限 M）」。
console.log('页脚用的是「（全部）」措辞:', footText.includes('（全部）'), '| 还有「（上限」残留吗:', footText.includes('（上限'));

const beforeCalls = calls.length;
watchState.payload = {
  ...watchState.payload,
  counts: { new: 2, status: 1, closed: 0, total: 3 },
  changes: [{ kind: 'new', key: 'APP-8888', summary: '又来一条', status: 'Backlog', at: '2026-11-18T07:31:00.000Z' }, ...watchState.payload.changes],
};
await new Promise((r) => setTimeout(r, 400));
console.log('又有新变化后新增命令:', JSON.stringify(calls.slice(beforeCalls).map((row) => row.line)));

panel = renderPanel();
const ackBtn = collect(panel, (row) => row.type === 'button' && text(row).trim() === '标记已读')[0];
if (ackBtn) {
  ackBtn.props.onClick();
  await new Promise((r) => setTimeout(r, 250));
  panel = renderPanel();
}
console.log('标记已读：POST 次数 =', watchState.acked,
  '| 横幅 =', collect(panel, (row) => row.props?.className === 'jmw-watch').length ? '仍在' : '已消失',
  '| 角标 =', collect(renderEntry(true), (row) => row.props?.className === 'jmw-entry-badge').length ? '仍在' : '已消失');

watchState.mode = 'gone';
await new Promise((r) => setTimeout(r, 300));
panel = renderPanel();
const foot2 = collect(panel, (row) => row.props?.className === 'jmw-foot')[0];
console.log('通道 404 后页脚:', foot2 ? text(foot2).replace(/\s+/g, ' ').trim() : '（无）');


/* ---------------------------------------------------------- 改状态 */

const settleStatus = () => new Promise((resolve) => setTimeout(resolve, 300));


console.log('\n=== 改状态 ===');

// 重新拉一次列表（范围固定 all）
findByLabel(renderPanel(), '刷新').props.onClick();
await settleStatus();
panel = renderPanel();
console.log('行数:', rows(panel).length, '| 状态徽标按钮数:', statusButtons(panel).length);

const first = rows(panel)[0];
const firstKey = text(collect(first, (row) => String(row.props.className ?? '') === 'jmw-key')[0]).trim();
const badgeBtn = collect(first, (row) => row.type === 'button' && String(row.props.className ?? '').startsWith('jmw-badge act'))[0];
console.log('第一行:', firstKey, '| 徽标文案:', JSON.stringify(text(badgeBtn).trim()), '| aria-expanded:', badgeBtn.props['aria-expanded']);

badgeBtn.props.onClick({ preventDefault() {}, stopPropagation() {} });
await settleStatus();
panel = renderPanel();
let chips = menuChips(panel);
console.log('点徽标后：GET =', JSON.stringify(transitionCalls.map((c) => `${c.method} ${c.url.split('?')[1] ?? ''}`)));
console.log('下拉 chip 数 =', chips.length, '| 文案 =', chips.map((c) => text(c).trim()).join(' / '));
console.log('当前状态那项 disabled =', chips.filter((c) => c.props.disabled).map((c) => text(c).trim()).join(', '));
const menu = collect(panel, (row) => String(row.props.className ?? '') === 'jmw-menu')[0];
console.log('下拉标题:', JSON.stringify(text(collect(menu, (row) => String(row.props.className ?? '') === 'jmw-menu-head')[0]).replace(/\s+/g, ' ').trim()));

// 选 IN QA
const target = menuChips(renderPanel()).find((c) => text(c).trim() === 'IN QA');
console.log('\n点「IN QA」…');
target.props.onClick({ preventDefault() {}, stopPropagation() {} });
await settleStatus();
panel = renderPanel();
const post = transitionCalls.filter((c) => c.method === 'POST').pop();
console.log('POST body:', JSON.stringify(post?.body));
const flashNodes = collect(panel, (row) => String(row.props.className ?? '') === 'jmw-flash');
console.log('一次性提示:', JSON.stringify(flashNodes.map((row) => text(row)).join('').trim()));
console.log('下拉是否已收起:', collect(panel, (row) => String(row.props.className ?? '') === 'jmw-menu').length === 0);
console.log('改完自动重取列表:', JSON.stringify(calls.slice(-1).map((row) => row.line)));

// 失败路径：Jira 报必填字段
transitionState.fail = true;
panel = renderPanel();
const badge2 = statusButtons(panel)[0];
badge2.props.onClick({ preventDefault() {}, stopPropagation() {} });
await settleStatus();
panel = renderPanel();
const target2 = menuChips(panel).find((c) => text(c).trim().startsWith('已完成'));
target2.props.onClick({ preventDefault() {}, stopPropagation() {} });
await settleStatus();
panel = renderPanel();
console.log('\n失败时下拉里的错误:', JSON.stringify(text(collect(panel, (row) => String(row.props.className ?? '') === 'jmw-menu-note err')[0] ?? { type: '#text', props: {}, children: [], text: '(无)' }).trim()));
transitionState.fail = false;

// Esc：先收下拉，再关面板
const esc = { key: 'Escape', preventDefault() {} };
keyHandlers.slice(-1)[0](esc);
panel = renderPanel();
console.log('Esc 一次：下拉收起 =', collect(panel, (row) => String(row.props.className ?? '') === 'jmw-menu').length === 0, '| 面板仍在 =', Boolean(panel));
keyHandlers.slice(-1)[0](esc);
console.log('Esc 两次：renderPanel =', renderPanel());

/* ------------------------------------------------- 优先级高亮 / 去掉「进行中」 */

console.log('\n=== 优先级高亮 ===');
const entry3 = renderEntry(true);
collect(entry3, (row) => row.type === 'button')[0].props.onClick();
await settle();
panel = renderPanel();
const heads3 = groupHeads(panel);
console.log('组头文案:', heads3.map((head) => text(head).replace(/\s+/g, ' ').trim()).join(' | '));
console.log('组头里还有「进行中」吗:', heads3.some((head) => text(head).includes('进行中')));
const byLevel = { highest: [], high: [], none: [] };
for (const row of rows(panel)) {
  const cls = String(row.props.className ?? '');
  const keyNode = collect(row, (r) => String(r.props.className ?? '') === 'jmw-key')[0];
  const key = keyNode ? text(keyNode).trim() : '?';
  const level = cls.includes('pri-highest') ? 'highest' : (cls.includes('pri-high') ? 'high' : 'none');
  byLevel[level].push(key);
}
console.log('pri-highest:', byLevel.highest.join(', ') || '（无）');
console.log('pri-high   :', byLevel.high.join(', ') || '（无）');
console.log('无高亮     :', byLevel.none.join(', ') || '（无）');
console.log('状态徽标按钮仍可用:', statusButtons(panel).length, '个');

/* ------------------------------------------------- 切换范围时中断旧请求 */

console.log('\n=== 切换筛选时中断旧请求 ===');
commandDelayMs = 500;               // 第一个筛选故意很慢
filterButton(panel).props.onClick();
panel = renderPanel();
const slowChip = menuChips(panel)[1] ?? menuChips(panel)[0];
const slowName = text(slowChip).trim().replace(/\s*✓$/, '');
slowChip.props.onClick({ preventDefault() {} });
await new Promise((resolve) => setTimeout(resolve, 40));
commandDelayMs = 30;                // 紧接着切另一个筛选，它很快
// useSnapshot 每次 patch 都返回新快照，闭包里拿到的是「渲染那一刻」的 state：
// 必须重新 renderPanel() 拿到 filterOpen === false 的新按钮节点，否则这一点是「关菜单」。
panel = renderPanel();
filterButton(panel).props.onClick();
panel = renderPanel();
const fastChip = menuChips(panel).find((chip) => text(chip).trim().replace(/\s*✓$/, '') !== slowName) ?? menuChips(panel)[0];
const fastName = text(fastChip).trim().replace(/\s*✓$/, '');
fastChip.props.onClick({ preventDefault() {} });
await new Promise((resolve) => setTimeout(resolve, 1200));
commandDelayMs = 0;
panel = renderPanel();
const pair = calls.slice(-2);
console.log('慢筛选:', JSON.stringify(slowName), '→ 快筛选:', JSON.stringify(fastName));
console.log('两次调用都带了 signal:', pair.every((row) => row.signal !== undefined));
console.log('先发的那个已被 abort:', pair[0]?.signal?.aborted === true, '| 后发的没被 abort:', pair[1]?.signal?.aborted === false);
console.log('命令顺序:', pair.map((row) => row.line).join(' → '));
console.log('界面没有显示取消错误:', !text(panel).includes('aborted') && !text(panel).includes('已中止'));
const finalSub = text(collect(panel, (row) => classNameOf(row) === 'jmw-sub')[0]).replace(/\s+/g, ' ').trim();
const finalCount = /共 (\d+) 项/.exec(finalSub)?.[1];
console.log('最终可见行数:', rows(panel).length, '| 副标题:', JSON.stringify(finalSub));
// --limit=0 取到完：可见行数应当就是副标题里的准确总数（真站点 332 条时即「共 332 项」）。
console.log('副标题数字 === 可见行数（取到完，没被上限截断）:', finalCount === String(rows(panel).length), `（共 ${finalCount} 项 / ${rows(panel).length} 行）`);
console.log('虚拟列表占位高:', collect(panel, (row) => classNameOf(row) === 'jmw-vlist')[0]?.props?.style?.height,
  '| 一维条目数:', collect(panel, (row) => classNameOf(row) === 'jmw-vrow').length,
  '| 渐进式渲染残留:', collect(panel, (row) => classNameOf(row) === 'jmw-rendering').length, '（期望 0）');

for (const off of effects) { try { off?.(); } catch { /* ignore */ } }
console.log('监视循环已停止');
