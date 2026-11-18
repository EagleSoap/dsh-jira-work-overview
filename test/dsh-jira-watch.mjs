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

const clientCtx = {
  get(name) {
    if (name === 'sessions') return { list: { getSnapshot: () => ({ byId: sessionRows }) } };
    if (name === 'remote.commands') {
      return {
        async execute(sessionId, line, attachments) {
          calls.push({ sessionId, line, attachments });
          try {
            const outcome = await hostCommand.handler({
              commandId: 'jira', rawInput: line.replace(/^\/jira\s*/, ''), attachments, signal: undefined,
            });
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
const mod = spec.factory((name) => {
  if (name === 'react') return React;
  if (name === 'react-dom') return { createPortal: (node) => node };
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
  return collect(tree, (row) => row.type === 'a' && String(row.props.className ?? '').startsWith('jmw-row'));
}

console.log('\n入口(wide):', text(renderEntry(true)).trim());
console.log('入口(窄)文案节点:', JSON.stringify(text(renderEntry(false)).trim()));

// 点入口 → 打开并加载
const entry = renderEntry(true);
collect(entry, (row) => row.type === 'button')[0].props.onClick();
await settle();

let panel = renderPanel();
console.log('\n打开后命令:', JSON.stringify(calls.map((row) => row.line)));
console.log('分组数:', groupHeads(panel).length);
for (const head of groupHeads(panel)) console.log('  ·', text(head).replace(/\s+/g, ' ').trim());
console.log('可见行数(默认):', rows(panel).length);
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

// 切到「当前迭代」
const findButton = (tree, label) => collect(tree, (row) => row.type === 'button' && text(row).trim() === label)[0];
findButton(panel, '当前迭代').props.onClick();
await settle();
panel = renderPanel();
console.log('\n切换后命令:', JSON.stringify(calls.map((row) => row.line)));
console.log('分组:', groupHeads(panel).map((head) => text(head).replace(/\s+/g, ' ').trim()).join(' | '));
console.log('可见行数:', rows(panel).length);

// 切到「全部」：全是已完成的分组应默认折叠
findButton(panel, '全部').props.onClick();
await settle();
panel = renderPanel();
const allGroups = groupHeads(panel);
console.log('\n全部范围：命令 =', JSON.stringify(calls[calls.length - 1].line));
console.log('分组数 =', allGroups.length, '| 默认可见行数 =', rows(panel).length, '| 默认折叠的分组数 =', allGroups.filter((g) => g.props['aria-expanded'] === 'false').length);
console.log('分组概览:', allGroups.map((head) => text(head).replace(/\s+/g, ' ').trim()).join(' | '));

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
console.log('页脚:', foot ? text(foot).replace(/\s+/g, ' ').trim() : '（无）');

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

for (const off of effects) { try { off?.(); } catch { /* ignore */ } }
console.log('监视循环已停止');
