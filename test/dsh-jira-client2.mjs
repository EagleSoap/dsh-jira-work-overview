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
  effect(fn) { return fn(); },
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
