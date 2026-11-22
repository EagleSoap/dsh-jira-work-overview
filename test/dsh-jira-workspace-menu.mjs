/**
 * 离线回归：左侧栏「工作区」右键菜单里的「关联 Jira 项目…」。
 *
 * 浏览器侧的插件入口是**并发创建**的：本插件的 apply 只等 slots / remote，而 `contextMenus`
 * 服务还要等 locale、shortcuts，所以 apply 时它常常还没就绪。0.16.1 及以前这里直接
 * `ctx.get('contextMenus')` 拿一次，拿不到就整页都没有这条菜单 —— 表现就是「绑定选项消失了」。
 * 现在改成 `ctx.inject(['contextMenus'], …)` 等它出现再注册；这个套件把「晚到」这件事真的模拟出来：
 *   1. apply 时没有 contextMenus → 一个贡献都不注册，但已经在等这个服务；
 *   2. 服务出现后 → 注册 target 'workspace' 的贡献；
 *   3. 该贡献 resolve 出一个「关联 Jira 项目…」条目，点它会打开面板并去读/写映射；
 *   4. 老基座没有 ctx.inject 时退回直接注册（服务当时在就注册）。
 */
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const WS = dirname(dirname(fileURLToPath(import.meta.url)));

let failed = 0;
const check = (ok, label, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : ` | ${detail}`}`);
  if (!ok) failed += 1;
};

/* ------------------------------------------------------- 浏览器最小环境 */

const loaded = [];
const styleTags = [];
const fakeDocument = {
  querySelector: () => null,
  createElement: () => ({ dataset: {}, style: {}, textContent: '', remove() {} }),
  head: { appendChild: (tag) => styleTags.push(tag) },
};
Object.defineProperty(globalThis, 'document', { value: fakeDocument, configurable: true });
Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN', languages: ['zh-CN'] }, configurable: true });

const fetchCalls = [];
const fakeWindow = {
  __ModuleLoader__: { load: (spec) => { loaded.push(spec); } },
  __DSH_TRANSPORT__: {
    fetch: async (url, init) => {
      const path = String(url).split('?')[0];
      fetchCalls.push({ path, method: String(init?.method ?? 'GET').toUpperCase() });
      const json = (payload) => ({ ok: true, status: 200, async json() { return payload; } });
      if (path === '/api/jira-work-overview/project-workspace') {
        return json({ ok: true, mapping: {}, workspaces: {}, items: [] });
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
      return json({ ok: true, watch: { enabled: false, counts: { new: 0, status: 0, closed: 0, total: 0 }, changes: [] } });
    },
  },
};
Object.defineProperty(globalThis, 'window', { value: fakeWindow, configurable: true });

const React = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
  useEffect: () => {}, useRef: (value) => ({ current: value }), useMemo: (fn) => fn(),
  useCallback: (fn) => fn, useLayoutEffect: () => {},
};
const modules = {
  react: React,
  'react-dom': { createPortal: (node) => node },
  '@tanstack/react-virtual': {
    useVirtualizer: () => ({ getTotalSize: () => 0, getVirtualItems: () => [], measureElement() {}, scrollToIndex() {} }),
  },
};

/** 一个够 apply 跑完的上下文；`inject` 只记下回调，等测试手动放行。 */
function makeCtx(options = {}) {
  const injected = [];
  const ctx = {
    injected,
    get(name) {
      if (name === 'sessions') {
        return { list: { getSnapshot: () => ({ byId: { 'sess-1': { id: 'sess-1', retainedBy: { mainView: 1 } } } }) } };
      }
      if (name === 'workspaces') {
        return { list: { getSnapshot: () => ({ items: [{ workspaceId: 'ws-1', sessionIds: ['sess-1'] }] }) } };
      }
      if (name === 'remote.commands') {
        return {
          async execute() {
            return {
              ok: true,
              value: {
                result: {
                  kind: 'success',
                  text: JSON.stringify({
                    ok: true, project: 'APP', counts: { new: 0, indeterminate: 0, done: 0, total: 0 },
                    total: 0, projectTotals: {}, statusOptions: [], items: [], sprints: [],
                  }),
                },
              },
            };
          },
        };
      }
      return undefined;
    },
    on() { return () => {}; },
    effect(fn) { const off = fn(); return () => { if (typeof off === 'function') off(); }; },
    slots: { inject(name, factory) { factory(); }, register() { return () => {}; } },
  };
  if (options.inject !== false) {
    ctx.inject = (deps, callback) => { injected.push({ deps: [...deps], callback }); };
  }
  if (options.contextMenus) ctx.get = ((base) => (name) => (name === 'contextMenus' ? options.contextMenus : base(name)))(ctx.get);
  return ctx;
}

const menuService = () => {
  const contributions = [];
  return {
    contributions,
    register(contribution) { contributions.push(contribution); return () => {}; },
  };
};

/** 一个只要求 get / effect 的子上下文（ctx.inject 回调拿到的就是这种上下文）。 */
const childOf = (ctx, service) => ({
  get: (name) => (name === 'contextMenus' ? service : ctx.get(name)),
  effect: ctx.effect,
  slots: ctx.slots,
});

await import(pathToFileURL(`${WS}/client.js`).href);
const spec = loaded[0];
check(Boolean(spec && spec.factory), 'client 半边的 bundle 能加载');

/* --------------------------------------------- 1) 服务晚到：等它出现再注册 */

const late = makeCtx();
spec.factory((name) => modules[name]).apply(late);
check(late.injected.length === 1 && late.injected[0].deps.includes('contextMenus'),
  'apply 时先等 contextMenus 服务（不直接 ctx.get 一次就放弃）',
  late.injected.map((row) => row.deps.join(',')).join(' | '));

const service = menuService();
check(service.contributions.length === 0, '服务还没出现时一个菜单贡献都不注册');
late.injected[0].callback(childOf(late, service));
check(service.contributions.length === 1, '服务晚到后补注册了菜单贡献', String(service.contributions.length));

const contribution = service.contributions[0];
check(contribution.target === 'workspace' && contribution.id.endsWith('.workspace-project'),
  '注册的是「工作区」这一族的菜单贡献', `${contribution.target} / ${contribution.id}`);
check(Array.isArray(contribution.observe({ workspaceId: 'ws-1' })) && contribution.observe({ workspaceId: 'ws-1' }).length === 1,
  'observe 把工作区列表作为响应式输入');

/* --------------------------------------------- 2) resolve / 点击后的行为 */

const before = fetchCalls.length;
const actions = contribution.resolve({ workspaceId: 'ws-1', path: '/tmp/ws', displayTitle: 'ws' });
check(Array.isArray(actions) && actions.length >= 1, 'resolve 至少返回一条菜单项', String(actions?.length));
check(actions?.some((action) => action.label === '关联 Jira 项目…'),
  '菜单里有「关联 Jira 项目…」', actions?.map((action) => action.label).join(' | '));

await actions[0].run();
await new Promise((resolve) => setTimeout(resolve, 60));
check(fetchCalls.slice(before).some((call) => call.path === '/api/jira-work-overview/project-workspace' && call.method === 'GET'),
  '点「关联 Jira 项目…」会去读一次映射并打开面板');

/* --------------------------------------------- 3) 老基座：没有 ctx.inject 时直接注册 */

const early = makeCtx({ inject: false, contextMenus: menuService() });
spec.factory((name) => modules[name]).apply(early);
check(early.get('contextMenus')?.contributions?.length === 1,
  '没有 ctx.inject 的老基座：服务当时就在时直接注册');

console.log(failed === 0 ? '\n全部通过' : `\n失败 ${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
