import { prepareHostCopy, skipWhenUnavailable } from './lib-host-runtime.mjs';
// 离线端到端：真 host 命令 + 真 client 组件（按 sprint 分组 + 折叠/展开）。
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/* --- 跨平台：临时目录与本机凭据文件（Windows 上用 os.tmpdir()，可用 DSH_JIRA_TMP 覆盖） --- */
const TMP = process.env.DSH_JIRA_TMP || (existsSync(join('/tmp', '.dsh_jira_env')) ? '/tmp' : tmpdir());
const HOST_COPY = join(TMP, 'dsh-jira-smoke3', 'index.js');
const ENV_FILE = process.env.DSH_JIRA_ENV_FILE || join(TMP, '.dsh_jira_env');
/* 没有非交互式环境文件（典型是 Linux / Windows 没建过）时开一个空文件，凭据由 JIRA_API_TOKEN / JIRA_BASE_URL / JIRA_EMAIL 环境变量提供，套件照常 SKIP 而不是崩。 */
mkdirSync(TMP, { recursive: true }); // TMP 目录本身也可能还不存在（干净机器 / CI）
if (!existsSync(ENV_FILE)) writeFileSync(ENV_FILE, '', { mode: 0o600 });
mkdirSync(join(TMP, 'dsh-jira-smoke3'), { recursive: true });

const WS = dirname(dirname(fileURLToPath(import.meta.url)));
const prep = prepareHostCopy({ ws: WS, dest: HOST_COPY });
skipWhenUnavailable(prep);

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
        if (String(url).split('?')[0] === '/api/jira-work-overview/credential') {
          return credentialFetch(String(url), init ?? {});
        }
        if (String(url).split('?')[0] === '/api/jira-work-overview/transition') {
          return transitionFetch(String(url), init ?? {});
        }
        if (String(url).split('?')[0] === '/api/jira-work-overview/settings') {
          return settingsFetch(String(url), init ?? {});
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

/* ------------------------------------------- 令牌通道 stub（转发给真 host 路由） */

const GOOD = 'ATATT3xFfGF0GOODTOKENGOODTOKENGOODTOKENGOOD1DB8F000';
const BAD = 'ATATT3xFfGF0BADTOKENBADTOKENBADTOKENBAD01DB8F000';
const netState = { mode: 'ok' };
const myselfCalls = [];

async function settingsFetch(url, init) {
  const path = String(url).split('?')[0];
  const route = watchRoutes.find((row) => row.path === path);
  if (!route) return { ok: false, status: 404, async json() { return { ok: false, error: 'no route' }; } };
  const method = String(init?.method ?? 'GET').toUpperCase();
  const request = method === 'POST'
    ? new Request(`http://dsh.invalid${path}`, { method, headers: { 'content-type': 'application/json' }, body: String(init?.body ?? '{}') })
    : new Request(`http://dsh.invalid${path}`);
  const response = await route.fetch(request);
  return { ok: response.ok, status: response.status, async json() { return response.json(); } };
}

async function credentialFetch(url, init) {
  await new Promise((resolve) => setTimeout(resolve, 20));
  const route = watchRoutes.find((row) => row.path === '/api/jira-work-overview/credential');
  return route.fetch(new Request(`http://dsh.invalid${url}`, init));
}

Object.defineProperty(globalThis, 'fetch', {
  configurable: true,
  writable: true,
  value: async (url, init) => {
    const auth = init?.headers?.Authorization ?? '';
    const decoded = Buffer.from(String(auth).replace(/^Basic /, ''), 'base64').toString('utf8');
    const email = decoded.slice(0, decoded.indexOf(':'));
    const token = decoded.slice(decoded.indexOf(':') + 1);
    myselfCalls.push({ url: String(url), email, token, at: Date.now() });
    if (netState.mode === 'down') throw new TypeError('fetch failed');
    if (String(url).endsWith('/rest/api/3/myself')) {
      // 只有「好令牌 + 企业邮箱域」这一对才算通过，用来验证邮箱与令牌的绑定关系。
      if (token === GOOD && email.endsWith('@example.com')) {
        return { ok: true, status: 200, async text() { return JSON.stringify({ displayName: '张三', accountId: '000000:00000000-0000-0000-0000-000000000000' }); } };
      }
      return {
        ok: false,
        status: 401,
        async text() {
          return JSON.stringify({ errorMessages: ['Client must be authenticated to access this resource.'] });
        },
      };
    }
    return { ok: true, status: 200, async text() { return '{}'; } };
  },
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
  async unset(key) {
    store.delete(key);
  },
};
const settingsWrites = [];
const settingsService = {
  documentPath: join(WS, 'cordis.patch.yml'),
  describe() {
    return [{ ns: 'jira-work-overview', revision: 7, autoGenerate: false }];
  },
  async mutate(ns, ops, expectedRevision) {
    settingsWrites.push({ ns, ops, expectedRevision });
  },
};
// 照真宿主的时序搭桩：client-connection 的 apply 是异步的（要先建 BrowserAuth 密钥），同一个
// 加载批里 ctx.get('connection') 还是 undefined，只有 ctx.inject 的回调会在服务 provide 之后跑。
// 旧实现同步 ctx.get 拿不到就永久丢掉四条路由（浏览器侧 GET /api/jira-work-overview/credential 404），
// 这里让这种回归直接失败。
const connectionService = { fetch: { register(route) { watchRoutes.push(route); return async () => {}; } } };
let connectionReady = false;
const pendingInjects = [];
const hostCtx = {
  get(name) {
    if (name === CRED) return credentials;
    if (name === 'settings') return settingsService;
    if (name === 'commands') {
      return { register(definition) { hostCommands.push(definition); return () => {}; } };
    }
    if (name === 'connection') return connectionReady ? connectionService : undefined;
    return undefined;
  },
  inject(deps, callback) {
    pendingInjects.push({ deps: Array.isArray(deps) ? deps : [], callback });
    return {};
  },
  tools: { register(definition) { hostTools.set(definition.name, definition); } },
};

const host = await import(pathToFileURL(HOST_COPY).href);
// 用 Config() 生成配置：宿主就是这么传的 —— volatile 字段此时是「引用对象」，
// 插件必须脱壳才能读到值（读错就会静默掉回默认值）。
const hostConfig = host.Config({
  baseUrl: env.JIRA_BASE_URL,
  email: env.JIRA_EMAIL,
  apiToken: env.JIRA_API_TOKEN,
  projectKey: 'APP',
  boardId: 42,
  maxResults: 50,
  timeoutMs: 30000,
  watchIntervalMs: 45000,
});
console.log('volatile 引用形态: watchIntervalMs =', typeof hostConfig.watchIntervalMs, '| get() =', typeof hostConfig.watchIntervalMs?.get === 'function' ? hostConfig.watchIntervalMs.get() : '(无 get)');
host.apply(hostCtx, hostConfig);
const hostCommand = hostCommands.find((row) => row.name === 'jira');
console.log('host: tools =', [...hostTools.keys()].join(','), '| commands =', hostCommands.map((row) => row.name).join(','));

/* 服务就绪：真宿主里 client-connection 稍后才 provide，插件必须用 ctx.inject 等它。 */
console.log('加载时 connection 已就绪:', connectionReady, '（真宿主为 false）| 待执行 inject 回调:', pendingInjects.length);
const connectionInjects = pendingInjects.filter((row) => row.deps.includes('connection'));
if (connectionInjects.length === 0) {
  console.log('FAIL: 插件没有通过 ctx.inject 等 connection 就绪 —— 同步 ctx.get 会永久丢掉四条 /api 路由（浏览器侧 404）');
  process.exit(1);
}
connectionReady = true;
// 回调收到的是拿到该服务的子上下文；其余服务照旧从同一份桩里取。
const readyCtx = { get: (name) => hostCtx.get(name), inject: hostCtx.inject, tools: hostCtx.tools };
for (const row of connectionInjects) row.callback(readyCtx);
// 6 条：state / transition / credential / settings / project-workspace / plan。
const EXPECTED_ROUTES = 6;
console.log('connection 就绪后注册的路由数:', watchRoutes.length, `（期望 ${EXPECTED_ROUTES}）`);
if (watchRoutes.length !== EXPECTED_ROUTES) process.exitCode = 1;

/* --------------------------------------------------------- client 半边 */

const calls = [];
const completed = [];
let commandDelayMs = 0;
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
/* ============================ 令牌通道：host 路由（真路由 + 假凭据库 + 假 Jira） ============================ */

const CRED_PATH = '/api/jira-work-overview/credential';
const route = watchRoutes.find((row) => row.path === CRED_PATH);
const asJson = async (response) => ({ status: response.status, body: await response.json() });

console.log('\n=== 通道注册 ===');
console.log('路由:', watchRoutes.map((r) => `${r.path} [${r.methods.join(',')}] ${r.requestBody}`).join(' | '));
console.log('令牌路由存在:', route !== undefined);

const getState = async () => asJson(await route.fetch(new Request(`http://dsh.invalid${CRED_PATH}`)));

/* ============================ 配置通道：volatile 字段写入 ============================ */

const SETTINGS_PATH = '/api/jira-work-overview/settings';
const settingsRoute = watchRoutes.find((row) => row.path === SETTINGS_PATH);
console.log('\n=== 配置通道（轮询开关 / 间隔 / 通知）===');
console.log('配置路由存在:', settingsRoute !== undefined, '| 方法:', settingsRoute?.methods.join(','));
const settingsGet = settingsRoute ? await asJson(await settingsRoute.fetch(new Request(`http://dsh.invalid${SETTINGS_PATH}`))) : { status: 0, body: {} };
console.log('GET 默认值:', JSON.stringify(settingsGet.body.watch), '| writable:', settingsGet.body.writable);
console.log('（校验）config 里给的 45000 生效:', settingsGet.body.watch?.watchIntervalMs === 45000);
const settingsPost = settingsRoute
  ? await asJson(await settingsRoute.fetch(new Request(`http://dsh.invalid${SETTINGS_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ watchEnabled: true, notify: false, watchIntervalMs: 30000 }),
  })))
  : { status: 0, body: {} };
console.log('POST 结果:', JSON.stringify({ status: settingsPost.status, ok: settingsPost.body.ok, persisted: settingsPost.body.persisted, watch: settingsPost.body.watch }));
console.log('写入调用:', JSON.stringify(settingsWrites.map((row) => ({ ns: row.ns, revision: row.expectedRevision, ops: row.ops }))));
const tooSmall = settingsRoute
  ? await asJson(await settingsRoute.fetch(new Request(`http://dsh.invalid${SETTINGS_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ watchIntervalMs: 1000 }),
  })))
  : { status: 0, body: {} };
console.log('间隔下限兜底:', tooSmall.body.watch?.watchIntervalMs, '（应为 15000）');
const emptyPatch = settingsRoute
  ? await asJson(await settingsRoute.fetch(new Request(`http://dsh.invalid${SETTINGS_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  })))
  : { status: 0, body: {} };
console.log('空 patch 被拒:', emptyPatch.status, JSON.stringify(emptyPatch.body.error));
const postToken = async (token) => asJson(await route.fetch(new Request(`http://dsh.invalid${CRED_PATH}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }),
})));
const postCred = async (body) => asJson(await route.fetch(new Request(`http://dsh.invalid${CRED_PATH}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})));
const postClear = async () => asJson(await route.fetch(new Request(`http://dsh.invalid${CRED_PATH}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clear: true }),
})));

const empty = await getState();
console.log('空凭据库:', empty.status, JSON.stringify(empty.body));

const saved = await postToken(GOOD);
console.log('保存好令牌:', saved.status, JSON.stringify(saved.body));
console.log('  打码:', saved.body.masked, '| 来源:', saved.body.source, '| 验证账号:', saved.body.verification?.account);
console.log('  响应里没有完整令牌:', !JSON.stringify(saved.body).includes(GOOD));
console.log('  凭据库里的值 === 输入:', store.get('JIRA_API_TOKEN') === GOOD);

const afterSave = await getState();
console.log('GET 也只给打码值:', JSON.stringify(afterSave.body), '| 无完整令牌:', !JSON.stringify(afterSave.body).includes(GOOD));

const rejected = await postToken(BAD);
console.log('坏令牌被拒:', rejected.status, JSON.stringify(rejected.body));
console.log('  拒绝后凭据库没被覆盖:', store.get('JIRA_API_TOKEN') === GOOD);

const shorty = await postToken('abc');
console.log('过短令牌:', shorty.status, JSON.stringify(shorty.body));

netState.mode = 'down';
const offline = await postToken(GOOD);
console.log('网络不通仍保存但提示:', offline.status, JSON.stringify(offline.body.verification));
netState.mode = 'ok';

// 邮箱与令牌绑定：只改邮箱（不填新令牌）也要先验证这一对
const emailOnly = await postCred({ email: 'you+new@example.com' });
console.log('只改邮箱:', emailOnly.status, JSON.stringify(emailOnly.body));
console.log('  用当前令牌验证通过 + 邮箱已写:', emailOnly.body.verification?.ok === true, '| emailSaved:', emailOnly.body.emailSaved,
  '| 当前邮箱:', emailOnly.body.email);

// 组合不对（换了个非企业邮箱）→ 拒绝，且两边都不写
const mismatched = await postCred({ email: 'someone@example.com' });
console.log('邮箱对不上:', mismatched.status, JSON.stringify(mismatched.body));
console.log('  被拒且邮箱没变:', mismatched.body.rejected === true, '| 当前邮箱仍是:', (await getState()).body.email);

// 邮箱 + 新令牌一起换
const both = await postCred({ email: 'you@example.com', token: GOOD });
console.log('邮箱 + 令牌一起保存:', both.status, '| tokenSaved:', both.body.tokenSaved, '| emailSaved:', both.body.emailSaved);

// 格式校验
const badEmail = await postCred({ email: 'not-an-email', token: GOOD });
console.log('邮箱格式校验:', badEmail.status, JSON.stringify(badEmail.body));

const cleared = await postClear();
console.log('清除:', cleared.status, JSON.stringify(cleared.body), '| 凭据库空:', store.size === 0);

/* ============================ 令牌配置页：client 半边（真组件 + 真路由） ============================ */

console.log('\n=== 配置页槽注册 ===');
console.log('注册过的槽:', slotRegistrations.map((row) => `${row.options.name}#${row.options.key ?? row.options.id ?? ''}`).join(' | '));
const bundleSlot = slotRegistrations.find((row) => row.options.name === 'plugins.bundle.config');
console.log('bundle.config key:', bundleSlot?.options.key, '（= 包名，插件详情页直接显示这一段）');
const credSlot = slotRegistrations.find((row) => row.options.name === 'plugins.row.config');
console.log('key:', credSlot?.options.key, '| label:', typeof credSlot?.options.label === 'function' ? credSlot.options.label() : credSlot?.options.label);

const credComponent = credSlot.component;
function renderCred(view) {
  currentComponent = 'CredentialSettings';
  hookIndex = 0;
  return expand(createElement(credComponent, { view }));
}
const field = (tree, cls) => collect(tree, (row) => String(row.props?.className ?? '').split(' ')[0] === cls)[0];
const buttonByText = (tree, label) => collect(tree, (row) => row.type === 'button' && text(row).trim() === label)[0];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let page = renderCred('page');
await wait(80);
page = renderCred('page');
console.log('未配置时显示:', field(page, 'jmw-cred-none') !== undefined, '| 打码块:', field(page, 'jmw-cred-masked') === undefined ? '（无）' : '（有）');
console.log('输入框存在:', field(page, 'jmw-cred-input') !== undefined, '| 邮箱输入框:', field(page, 'jmw-cred-email') !== undefined,
  '| 邮箱回填:', field(page, 'jmw-cred-email')?.props?.value);
console.log('保存按钮禁用（没输入、邮箱也没改）:', buttonByText(page, '保存并验证')?.props.disabled === true);
console.log('站点地址是可编辑输入框:', collect(page, (row) => row.type === 'input' && row.props?.id === 'jmw-base-url').length === 1, '| 键值对（只读项）:', collect(page, (row) => String(row.props?.className ?? '') === 'jmw-cred-pair').map((row) => text(row)).join(' ').slice(0, 90));
console.log('页面上有凭据库键说明:', text(page).includes('JIRA_API_TOKEN'), '| 有 Atlassian 链接:', collect(page, (row) => row.type === 'a' && String(row.props.href).includes('api-tokens')).length === 1);

const input = field(page, 'jmw-cred-input');
input.props.onInput({ target: { value: BAD } });
page = renderCred('page');
console.log('输入后可点保存:', buttonByText(page, '保存并验证')?.props.disabled === false);
buttonByText(page, '保存并验证').props.onClick();
await wait(120);
page = renderCred('page');
console.log('坏令牌 → 错误文案:', field(page, 'jmw-cred-msg') === undefined ? '（无）' : text(field(page, 'jmw-cred-msg')));
console.log('  凭据库仍为空:', store.size === 0, '| 输入框没被清空:', (field(page, 'jmw-cred-input')?.props.value ?? '') === BAD);

const input2 = field(page, 'jmw-cred-input');
input2.props.onInput({ target: { value: GOOD } });
page = renderCred('page');
buttonByText(page, '保存并验证').props.onClick();
await wait(120);
page = renderCred('page');
const okMsg = collect(page, (row) => String(row.props?.className ?? '').includes('jmw-cred-msg')).map((row) => text(row)).join(' | ');
console.log('好令牌 → 成功文案:', okMsg);
console.log('  打码显示:', field(page, 'jmw-cred-masked') ? text(field(page, 'jmw-cred-masked')) : '（无）');
console.log('  页面文本里没有完整令牌:', !text(page).includes(GOOD));
console.log('  输入框已清空:', (field(page, 'jmw-cred-input')?.props.value ?? '') === '');
console.log('  凭据库已写入:', store.get('JIRA_API_TOKEN') === GOOD);

// 邮箱与令牌绑定：只改邮箱（不填新令牌）也能保存，但要先验证这一对
const emailInput = field(page, 'jmw-cred-email');
console.log('邮箱输入框原文:', emailInput?.props?.value, '| 有绑定说明:', text(page).includes('令牌和邮箱是一对'));
emailInput.props.onInput({ target: { value: 'you+new@example.com' } });
page = renderCred('page');
console.log('只改邮箱 → 保存按钮可用:', buttonByText(page, '保存并验证')?.props.disabled === false);
const emailWritesBefore = settingsWrites.length;
buttonByText(page, '保存并验证').props.onClick();
await wait(150);
page = renderCred('page');
console.log('只改邮箱 → 成功文案:', collect(page, (row) => String(row.props?.className ?? '').includes('jmw-cred-msg')).map((row) => text(row)).join(' | '));
console.log('  邮箱写进 profile patch:', settingsWrites.slice(emailWritesBefore).some((w) => w.ops.some((op) => op.path[0] === 'email' && op.value === 'you+new@example.com')));

// 组合不对（非企业邮箱）→ 被拒，邮箱不会写坏
field(page, 'jmw-cred-email').props.onInput({ target: { value: 'someone@example.com' } });
page = renderCred('page');
buttonByText(page, '保存并验证').props.onClick();
await wait(150);
page = renderCred('page');
const mismatchMsg = collect(page, (row) => String(row.props?.className ?? '').includes('jmw-cred-msg')).map((row) => text(row)).join(' | ');
console.log('组合不对 → 错误文案:', mismatchMsg.slice(0, 90));
console.log('  邮箱没被写坏:', (field(page, 'jmw-cred-email')?.props?.value ?? ''));

let summary = renderCred('summary');
console.log('summary（已配置）:', text(summary));

const clearBtn = buttonByText(page, '清除令牌');
clearBtn.props.onClick();
page = renderCred('page');
const confirmBtn = buttonByText(page, '确认清除？');
console.log('第一次点清除 → 变成确认:', confirmBtn !== undefined, '| 还没删:', store.size === 1);
confirmBtn.props.onClick();
await wait(80);
page = renderCred('page');
const clearMsg = collect(page, (row) => String(row.props?.className ?? '').includes('jmw-cred-msg')).map((row) => text(row)).join(' | ');
console.log('确认后:', clearMsg, '| 凭据库已空:', store.size === 0);

summary = renderCred('summary');
console.log('summary（未配置）:', text(summary));

/* ============================ 配置页：标题 + 内容 分组 / 监视表单 ============================ */
console.log('\n=== 配置页结构（标题 + 内容，按功能分组）===');
const settingsComponent = slotRegistrations.find((row) => row.options.name === 'plugins.bundle.config')?.component;
let credPage = settingsComponent ? renderCred('page') : null;
await wait(120);
credPage = settingsComponent ? renderCred('page') : null;
const classNameOf = (row) => String(row.props?.className ?? '');
const groupTitle = (group) => text(field(group, 'jmw-cred-grouptitle')).trim();
const groups = credPage ? collect(credPage, (row) => classNameOf(row) === 'jmw-cred-group') : [];
console.log('分组（标题）:', groups.map(groupTitle).join(' / '));
console.log('分组数:', groups.length, '（期望 6：界面 / 认证令牌 / Jira 连接 / 查询 / 后台监视 / 配置文件）');
const intervalInput = credPage ? collect(credPage, (row) => row.type === 'input' && row.props?.id === 'jmw-watch-interval')[0] : undefined;
const switches = credPage ? collect(credPage, (row) => row.type === 'input' && row.props?.type === 'checkbox') : [];
console.log('检查间隔输入框:', intervalInput !== undefined, '| 显示值(秒):', intervalInput?.props?.value, '| 开关数:', switches.length);
console.log('小字说明（第一个）:', text(collect(credPage, (row) => classNameOf(row) === 'jmw-cred-hint')[0]).trim().slice(0, 30));
// 条数（maxResults）也是可改字段：输入框 + 改了就生效
const resultsInput = credPage ? collect(credPage, (row) => row.type === 'input' && row.props?.id === 'jmw-results')[0] : undefined;
console.log('条数输入框:', resultsInput !== undefined, '| 显示值:', resultsInput?.props?.value, '| min/max:', `${resultsInput?.props?.min}-${resultsInput?.props?.max}`, '（min 应为 0 = 不限制）');
if (resultsInput) {
  const before = settingsWrites.length;
  resultsInput.props.onInput({ target: { value: '100' } });
  resultsInput.props.onChange({ target: { value: '100' } });
  await wait(250);
  const last = settingsWrites[settingsWrites.length - 1];
  console.log('改条数 → 自动写入:', settingsWrites.length > before, '| maxResults:', last?.ops.find((op) => op.path[0] === 'maxResults')?.value);
  // 0 = 不限制：必须能被写下去，不能被「Number(x) || 默认」之类的写法吞成 500。
  const beforeZero = settingsWrites.length;
  const fresh = renderCred('page');
  const zeroInput = collect(fresh, (row) => row.type === 'input' && row.props?.id === 'jmw-results')[0];
  zeroInput.props.onInput({ target: { value: '0' } });
  zeroInput.props.onChange({ target: { value: '0' } });
  await wait(250);
  const zeroWrite = settingsWrites[settingsWrites.length - 1];
  console.log('输入 0 → 自动写入:', settingsWrites.length > beforeZero, '| maxResults:', zeroWrite?.ops.find((op) => op.path[0] === 'maxResults')?.value, '（期望 0 = 不限制）');
  credPage = renderCred('page');
}
// 站点地址：可编辑输入框，placeholder 显示当前生效地址；填了就写进 profile 的 Cordis patch
const baseUrlInput = () => collect(credPage, (row) => row.type === 'input' && row.props?.id === 'jmw-base-url')[0];
console.log('站点地址输入框:', baseUrlInput() !== undefined, '| 初始值:', JSON.stringify(baseUrlInput()?.props?.value ?? null),
  '| placeholder = 当前地址:', baseUrlInput()?.props?.placeholder);
console.log('空输入时保存按钮禁用:', buttonByText(credPage, '保存地址')?.props?.disabled === true);
if (baseUrlInput()) {
  baseUrlInput().props.onInput({ target: { value: 'https://new-site.atlassian.net/' } });
  credPage = renderCred('page');
  console.log('输入后保存按钮可用:', buttonByText(credPage, '保存地址')?.props?.disabled === false);
  const beforeBaseUrl = settingsWrites.length;
  buttonByText(credPage, '保存地址').props.onClick();
  await wait(200);
  credPage = renderCred('page');
  const baseUrlWrite = settingsWrites[settingsWrites.length - 1];
  console.log('保存地址 → 写入 profile patch:', settingsWrites.length > beforeBaseUrl,
    '| baseUrl:', baseUrlWrite?.ops.find((op) => op.path[0] === 'baseUrl')?.value, '（尾斜杠应去掉）');
  console.log('  placeholder 已更新为新地址:', baseUrlInput()?.props?.placeholder);
  console.log('  输入框已清空:', (baseUrlInput()?.props?.value ?? '') === '');
  console.log('  成功提示:', collect(credPage, (row) => classNameOf(row).includes('jmw-cred-msg') && classNameOf(row).includes('ok')).map((row) => text(row).trim()).join(' | ') || '(没有)');
  // 非法地址：host 拒绝，界面报错且不写入
  baseUrlInput().props.onInput({ target: { value: 'not a url' } });
  credPage = renderCred('page');
  const beforeBad = settingsWrites.length;
  buttonByText(credPage, '保存地址').props.onClick();
  await wait(200);
  credPage = renderCred('page');
  console.log('非法地址 → 被拒:', settingsWrites.length === beforeBad,
    '| 错误文案:', collect(credPage, (row) => classNameOf(row).includes('jmw-cred-msg') && classNameOf(row).includes('err')).map((row) => text(row).trim()).join(' | '));
}
// 界面语言：三个 chip（自动 / 中文 / English），点了立刻写进 profile 的 Cordis patch
// 迷你 React 不保留 key，所以按「文本是三种语言名之一」来找（配置页里不会同时出现状态下拉的 chip）
const LANG_LABELS = ['自动', '中文', 'English'];
const langChips = credPage ? collect(credPage, (row) => row.type === 'button' && classNameOf(row).includes('jmw-chip')).filter((row) => LANG_LABELS.includes(text(row).trim())) : [];
console.log('界面语言 chip:', langChips.map((row) => text(row).trim()).join(' / '), '| 选中:', langChips.filter((row) => classNameOf(row).includes('cur')).map((row) => text(row).trim()).join(''));
if (langChips.length === 3) {
  const beforeLang = settingsWrites.length;
  langChips.find((row) => text(row).trim() === 'English').props.onClick();
  await wait(250);
  const lastLang = settingsWrites[settingsWrites.length - 1];
  console.log('点 English → 自动写入:', settingsWrites.length > beforeLang, '| language:',
    lastLang?.ops.find((op) => op.path[0] === 'language')?.value);
  credPage = renderCred('page');
  const after = collect(credPage, (row) => row.type === 'button' && classNameOf(row).includes('jmw-chip')).filter((row) => text(row).trim() === 'English')[0];
  console.log('切完 English 后选中态:', classNameOf(after).includes('cur'));
}
console.log('只有可改项是表单，其余成对只读:', collect(credPage, (row) => classNameOf(row) === 'jmw-cred-pair').length, '对 |', collect(credPage, (row) => classNameOf(row) === 'jmw-cred-value').map((row) => text(row)).join(' ').slice(0, 70));
// 按钮颜色走内联 style —— 宿主样式表后加载也刷不掉（用户看到过「白色按钮」）
const primary = credPage ? collect(credPage, (row) => row.type === 'button' && classNameOf(row).includes('jmw-cred-btn'))[0] : undefined;
console.log('按钮内联背景:', primary?.props?.style?.background, '| 内联文字色:', primary?.props?.style?.color);
console.log('监视组没有保存按钮（改了即生效）:', buttonByText(credPage, '保存监视设置') === undefined);
if (intervalInput !== undefined) {
  const before = settingsWrites.length;
  const freshInput = collect(credPage, (row) => row.type === 'input' && row.props?.id === 'jmw-watch-interval')[0];
  freshInput.props.onInput({ target: { value: '30' } });
  freshInput.props.onChange({ target: { value: '30' } });   // 失焦 / 回车 = 立刻落盘
  await wait(250);
  const lastInterval = settingsWrites[settingsWrites.length - 1];
  console.log('改间隔 → 自动写入:', settingsWrites.length > before,
    '| 间隔(ms):', lastInterval?.ops.find((op) => op.path[0] === 'watchIntervalMs')?.value);
  credPage = renderCred('page');
  const notifySwitch = collect(credPage, (row) => row.type === 'input' && row.props?.type === 'checkbox')[1];
  const before2 = settingsWrites.length;
  notifySwitch.props.onChange(false);
  await wait(250);
  const lastNotify = settingsWrites[settingsWrites.length - 1];
  console.log('拨通知开关 → 自动写入:', settingsWrites.length > before2,
    '| notify:', lastNotify?.ops.find((op) => op.path[0] === 'notify')?.value);
  credPage = renderCred('page');
  const okMsgs = collect(credPage, (row) => classNameOf(row).includes('jmw-cred-msg') && classNameOf(row).includes('ok')).map((row) => text(row).trim());
  console.log('页面上的成功提示:', okMsgs.join(' ｜ ') || '(没有)');
  console.log('监视设置已保存:', okMsgs.some((line) => line.includes('监视设置已保存')));
}

// 面板的数据通道：范围固定 all、条数固定 0 = 不限制（取到没有下一页为止，安全上限 5000 条 / 50 页 / 30s）；
// 范围分段控件（未完成 / 全部）与旧工具条已删除。
const entryComponent = slotRegistrations.find((row) => row.options.id === 'jira-work-overview')?.component;
const panelComponent = slotRegistrations.find((row) => row.options.id === 'jira-work-overview-panel')?.component;
if (entryComponent && panelComponent) {
  const entryTree = expand(createElement(entryComponent, { wide: true }));
  const entryButton = collect(entryTree, (row) => row.type === 'button')[0];
  const beforeCalls = calls.length;
  entryButton.props.onClick();
  await settle();
  const panelTree = expand(createElement(panelComponent, {}));
  console.log('\n面板首条命令:', calls[beforeCalls]?.line);
  console.log('命令带 --limit=0（不限制）:', /--limit=0(\s|$)/.test(calls[beforeCalls]?.line ?? ''), '| 取到的值:', /--limit=(\d+)/.exec(calls[beforeCalls]?.line ?? '')?.[1], '（期望 0）');
  console.log('范围分段控件 .jmw-seg:', collect(panelTree, (row) => classNameOf(row) === 'jmw-seg').length, '（期望 0）| .jmw-total:', collect(panelTree, (row) => classNameOf(row) === 'jmw-total').length, '（期望 0）');
  console.log('「未完成 / 全部」按钮:', collect(panelTree, (row) => row.type === 'button' && ['未完成', '全部', '当前迭代'].includes(text(row).trim())).length, '（期望 0）');
  // 这里面板的数据通道是真 host 命令（没打桩 Jira），所以 body 可能停在骨架 / 错误态：
  // .jmw-vlist 只在数据就绪时出现，因此两个数都只作信息打印，真正「虚拟化」的证据在 visual 测试。
  const bodyMix = ['jmw-vlist', 'jmw-skel', 'jmw-state', 'jmw-rendering'].map((name) => `${name}=${collect(panelTree, (row) => classNameOf(row) === name).length}`).join(' ');
  console.log('面板 body 节点分布:', bodyMix, '（渐进式渲染 .jmw-rendering 必须为 0）');
}

console.log('\nJira /myself 被调用次数:', myselfCalls.length);
console.log('监视循环已停止');
for (const off of effects) { try { off?.(); } catch { /* ignore */ } }
