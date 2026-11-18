// client.js 的端到端验证：假 window/React/document 驱动真实组件，数据走真实 host 命令 + 真实 Jira。
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
// host index.js 顶部 import 了 @deepseek-ai/schemastery，只有 os.tmpdir()/dsh-jira-smoke3 那份副本（用 DSH_JIRA_TMP 可改）
// （旁边有从 asar 拷出的 node_modules）能在宿主之外解析，所以先同步再 import。
copyFileSync(WS + '/index.js', HOST_COPY);
const env = readFileSync(ENV_FILE, 'utf8');
const token = (env.match(/JIRA_API_TOKEN=(.+)/) || [])[1]?.trim();
const CRED = ['creden', 'tials'].join('');

/* ---------- 浏览器侧的最小替身 ---------- */
let loadedModule = null;
const styleNodes = [];
globalThis.window = { __ModuleLoader__: { load: (def) => { loadedModule = def; } } };
const fakeDoc = {
  head: { appendChild: (node) => styleNodes.push(node) },
  body: {},
  activeElement: null,
  querySelector: () => null,
  getElementById: () => null,
  createElement: () => ({ dataset: {}, textContent: '', remove() {} }),
  addEventListener: () => {},
  removeEventListener: () => {},
};
globalThis.document = fakeDoc;
Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true });

// 只实现本插件用到的 hook 子集：useState 返回当前值，useEffect 立即执行。
const fakeReact = {
  createElement(type, props, ...children) {
    return { type, props: { ...(props || {}), children: children.length <= 1 ? children[0] : children } };
  },
  useState(initial) { return [typeof initial === 'function' ? initial() : initial, () => {}]; },
  useEffect(fn) { if (typeof fn === 'function') { const cleanup = fn(); return cleanup; } },
  useRef() { return { current: null }; },
};
const fakeReactDom = { createPortal: (node) => node };

function walk(node, visit) {
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) { for (const child of node) walk(child, visit); return; }
  if (typeof node !== 'object') return;
  // 函数组件要真的调用一次，否则拿不到它渲染出的宿主元素。
  if (typeof node.type === 'function') { walk(node.type(node.props), visit); return; }
  visit(node);
  if (node.props) walk(node.props.children, visit);
}
function collect(node) {
  const out = [];
  walk(node, (el) => { if (el.props && typeof el.props.className === 'string') out.push(el); });
  return out;
}
function textOf(node) {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (typeof node === 'object') return textOf(node.props && node.props.children);
  return '';
}
const ofClass = (tree, cls) => collect(tree).filter((el) => el.props.className.split(' ').includes(cls));
async function waitFor(fn, ms = 25000) {
  const until = Date.now() + ms;
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() > until) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, 250));
  }
}

/* ---------- host 半边：真实注册，拿到 /jira 命令 ---------- */
const registered = [];
let hostCommand = null;
const hostTools = [];
const store = new Map([['JIRA_API_TOKEN', token]]);
const hostCtx = {
  get: (name) => (name === CRED
    ? { resolve: async (k) => (store.has(k) ? { value: store.get(k), source: 'stored' } : undefined), set: async (k, v) => store.set(k, v) }
    : name === 'commands' ? { register: (def) => { registered.push(def.name); hostCommand = def; } } : undefined),
  tools: { register: (def) => hostTools.push(def) },
};
const host = await import(pathToFileURL(HOST_COPY).href);
host.apply(hostCtx, host.Config({
  baseUrl: 'https://example.atlassian.net', email: 'you@example.com', projectKey: 'APP',
  boardId: 42, credentialKey: 'JIRA_API_TOKEN', maxResults: 50, timeoutMs: 30000,
}));
await new Promise((r) => setTimeout(r, 300));
console.log('host: tools =', hostTools.map((d) => d.name).join(','), '| commands =', registered.join(','));

/* ---------- client 半边 ---------- */
const client = await import(pathToFileURL(WS + '/client.js').href);
console.log('client module id:', loadedModule.id);

function makeClient({ sessions }) {
  const slots = [];
  const injected = [];
  let lastLine = null;
  let lastSession = null;
  const commands = {
    async execute(sessionId, line) {
      lastLine = line;
      lastSession = sessionId;
      const outcome = await hostCommand.handler({ rawInput: line.replace(/^\/jira\s*/, '') });
      return { ok: true, value: { commandId: 'cmd-1', result: outcome } };
    },
  };
  const ctx = {
    slots: {
      inject: (name, cb) => { injected.push(name); return cb(); },
      register: (options, Component) => { slots.push({ options, Component }); return () => {}; },
    },
    effect: (fn) => { const cleanup = fn(); return () => { if (typeof cleanup === 'function') cleanup(); }; },
    get: (name) => {
      if (name === 'sessions') return sessions;
      if (name === 'remote.commands') return commands;
      return undefined;
    },
    remote: { commands },
  };
  const plugin = loadedModule.factory((id) => {
    if (id === 'react') return fakeReact;
    if (id === 'react-dom') return fakeReactDom;
    throw new Error('client require 了不该 require 的模块: ' + id);
  });
  plugin.apply(ctx);
  return {
    plugin,
    slots,
    injected,
    get lastLine() { return lastLine; },
    get lastSession() { return lastSession; },
    entry: () => slots.find((s) => s.options.name === 'sidebar.footer.action'),
    panel: () => slots.find((s) => s.options.name === 'shell.overlay'),
  };
}

const sessionsSvc = {
  list: {
    getSnapshot: () => ({
      byId: {
        'sess-blank': { id: 'sess-blank', retainedBy: { mainView: 0 } },
        'sess-main': { id: 'sess-main', retainedBy: { mainView: 1 } },
      },
    }),
  },
};

const app = makeClient({ sessions: sessionsSvc });
console.log('style 已注入:', styleNodes.length, '| style 标记:', JSON.stringify(styleNodes[0] && styleNodes[0].dataset));
console.log('inject:', plugin_inject(app.plugin), '| slots.inject 过的槽:', app.injected.join(', '));
console.log('入口注册:', JSON.stringify({ ...app.entry().options, label: app.entry().options.label() }));
console.log('浮层注册:', JSON.stringify(app.panel().options));

// 1) 折叠态/展开态都能画出入口
const narrow = app.entry().Component({ wide: false });
const wide = app.entry().Component({ wide: true });
console.log('\n入口(窄):', narrow.type, narrow.props.className, '| 文案节点:', ofClass(wide, 'jmw-entry-label').length ? textOf(wide) : '(无)');

// 2) 点击入口 → 拉数据（真实 Jira）
narrow.props.onClick();
let rows;
try {
  rows = await waitFor(() => {
    const tree = app.panel().Component({});
    const found = ofClass(tree, 'jmw-row');
    return found.length ? found : undefined;
  }, 25000);
} catch (error) {
  console.log('\n!! 没等到列表，面板当前内容：');
  console.log(textOf(app.panel().Component({})).slice(0, 400));
  throw error;
}
console.log('\n点击后命令:', app.lastLine, '| 会话:', app.lastSession);
console.log('列表行数:', rows.length);
const keys = ofClass(app.panel().Component({}), 'jmw-key').map((el) => textOf(el));
console.log('前 3 个 key:', keys.slice(0, 3).join(', '));
const badges = ofClass(app.panel().Component({}), 'jmw-badge').map((el) => textOf(el));
console.log('状态徽标:', [...new Set(badges)].join(' | '));
const groups = ofClass(app.panel().Component({}), 'jmw-group').map((el) => textOf(el));
console.log('分组:', groups.join(' / '));
const sprint = ofClass(app.panel().Component({}), 'jmw-sprint').map((el) => textOf(el));
console.log('迭代行:', sprint.join(''));
const footer = ofClass(app.panel().Component({}), 'jmw-foot').map((el) => textOf(el));
console.log('页脚:', footer.join(' | ').slice(0, 120));
const links = ofClass(app.panel().Component({}), 'jmw-key');
console.log('链接 href 示例:', links[0].props.href, '| target:', links[0].props.target);

// 3) 遮罩点击关闭 / 面板内点击不关闭
const panelTree = app.panel().Component({});
const mask = ofClass(panelTree, 'jmw-mask')[0];
mask.props.onClick();
console.log('\n点遮罩后：浮层还在吗 =', ofClass(app.panel().Component({}), 'jmw-mask').length > 0);
narrow.props.onClick(); // 再打开
await waitFor(() => ofClass(app.panel().Component({}), 'jmw-row').length);

// 4) 切范围到「当前迭代」：等页脚里的 query.scope 真的变成 sprint（否则会读到上一轮的旧列表）
const chips = ofClass(app.panel().Component({}), 'jmw-chip');
chips[1].props.onClick();
const sprintRows = await waitFor(() => {
  const tree = app.panel().Component({});
  const foot = ofClass(tree, 'jmw-foot').map((el) => textOf(el)).join('');
  const found = ofClass(tree, 'jmw-row');
  return foot.endsWith('sprint') && found.length ? found : undefined;
});
console.log('\n点「当前迭代」→ 命令:', app.lastLine, '| 行数:', sprintRows.length);
const sprintBadges = ofClass(app.panel().Component({}), 'jmw-badge').map((el) => textOf(el));
console.log('迭代范围下的徽标:', [...new Set(sprintBadges)].join(' | '));

// 5) 没有会话时报错而不是静默
const orphan = makeClient({ sessions: { list: { getSnapshot: () => ({ byId: {} }) } } });
orphan.entry().Component({ wide: true }).props.onClick();
const errorBox = await waitFor(() => {
  const found = ofClass(orphan.panel().Component({}), 'jmw-error');
  return found.length ? found : undefined;
});
console.log('无会话时的错误框:', textOf(errorBox[0]));

console.log('\n主 client 里 slots.inject 的槽名 =', app.injected.join(', '));
function plugin_inject(plugin) { return JSON.stringify(plugin.inject); }
