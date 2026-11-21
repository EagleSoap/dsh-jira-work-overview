#!/usr/bin/env node
import { prepareHostCopy, skipWhenUnavailable } from './lib-host-runtime.mjs';
/**
 * 离线：**自己**改的状态不该被下一轮后台轮询当成「变化」再通知一次。
 *
 * 场景（全部用 fetch 桩，不连真站点）：
 *   1. 首轮轮询只建基线；
 *   2. 别人改了状态 → 照常通知（这条不能因为加了对账就丢掉）；
 *   3. 面板 POST 改状态 → 下一轮轮询静默（不通知、不进未读角标），基线照样推进到新状态；
 *   4. 同事把同一个 issue 又改成别的状态 → 仍然通知（对账只吞「起点和终点都对得上自己」的那一次）；
 *   5. 工具 jira_transition apply=true 走的是同一条对账路径；
 *   6. 面板 POST 失败时不留残影：之后别人把它改成那个目标状态，仍然通知。
 *
 * 用法：ELECTRON_RUN_AS_NODE=1 "$BIN" test/dsh-jira-selfwatch.mjs
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/* host 半截 import 了 @deepseek-ai/schemastery（只在 DSH 应用里能解析），
   所以和 visual / credential 一样：把 index.js 拷到那份依赖旁边再 import。 */
const TMP = process.env.DSH_JIRA_TMP || (existsSync(join('/tmp', '.dsh_jira_env')) ? '/tmp' : tmpdir());
const HOST_COPY = join(TMP, 'dsh-jira-smoke3', 'index.js');
const prep = prepareHostCopy({ ws: dirname(dirname(fileURLToPath(import.meta.url))), dest: HOST_COPY });
skipWhenUnavailable(prep);
mkdirSync(dirname(HOST_COPY), { recursive: true });
copyFileSync(join(dirname(dirname(fileURLToPath(import.meta.url))), 'index.js'), HOST_COPY);
const mod = await import(pathToFileURL(HOST_COPY).href);

let failed = 0;
const check = (ok, label, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : ` | ${detail}`}`);
  if (!ok) failed += 1;
};

/* ---------------------------------------------------------------- fetch 桩 */

const issues = new Map([
  ['APP-1', { summary: '结算页空指针', status: '开始', category: 'new' }],
  ['APP-2', { summary: '导出超时', status: 'IN QA', category: 'indeterminate' }],
]);
let transitionFails = false;
const requests = [];
const json = (payload, status = 200) => ({
  ok: status < 400,
  status,
  statusText: status < 400 ? 'OK' : 'Bad Request',
  headers: { get: () => 'application/json' },
  async text() { return JSON.stringify(payload); },
  async json() { return payload; },
});
const empty = {
  ok: true,
  status: 204,
  statusText: 'No Content',
  headers: { get: () => '' },
  async text() { return ''; },
  async json() { return {}; },
};

globalThis.fetch = async (url, init = {}) => {
  const target = new URL(String(url));
  const method = String(init.method ?? 'GET').toUpperCase();
  const body = init.body ? JSON.parse(init.body) : null;
  requests.push({ method, path: target.pathname, body });
  if (target.pathname === '/rest/api/3/myself') {
    return json({ accountId: 'me', displayName: 'Me', emailAddress: 'me@example.com' });
  }
  if (target.pathname === '/rest/api/3/priority') {
    return json([{ id: '1', name: 'Highest' }, { id: '2', name: 'High' }, { id: '3', name: 'Medium' }]);
  }
  if (target.pathname === '/rest/api/3/search/jql') {
    const rows = [...issues].map(([key, row]) => ({
      key,
      fields: { summary: row.summary, status: { name: row.status, statusCategory: { key: row.category } } },
    }));
    return json({ issues: rows, total: rows.length });
  }
  const transitionMatch = target.pathname.match(/^\/rest\/api\/3\/issue\/([^/]+)\/transitions$/);
  if (transitionMatch && method === 'POST') {
    if (transitionFails) return json({ errorMessages: ['字段「解决结果」必填'] }, 400);
    const key = decodeURIComponent(transitionMatch[1]);
    const row = issues.get(key);
    if (!row) return json({ errorMessages: ['Issue does not exist'] }, 404);
    const next = String(body?.transition?.id) === '41'
      ? { status: '已完成', category: 'done' }
      : (String(body?.transition?.id) === '11'
        ? { status: 'Backlog', category: 'new' }
        : { status: '正在进行', category: 'indeterminate' });
    Object.assign(row, next);
    return empty;
  }
  if (transitionMatch && method === 'GET') {
    return json({
      transitions: [
        { id: '31', name: '正在进行', to: { name: '正在进行', statusCategory: { key: 'indeterminate' } } },
        { id: '11', name: '待办事项列表', to: { name: 'Backlog', statusCategory: { key: 'new' } } },
      ],
    });
  }
  const issueMatch = target.pathname.match(/^\/rest\/api\/3\/issue\/([^/]+)$/);
  if (issueMatch && method === 'GET') {
    const key = decodeURIComponent(issueMatch[1]);
    const row = issues.get(key);
    if (!row) return json({ errorMessages: ['Issue does not exist'] }, 404);
    return json({ key, fields: { status: { name: row.status, statusCategory: { key: row.category } } } });
  }
  return json({ errorMessages: [`unexpected ${method} ${target.pathname}`] }, 500);
};

/* ---------------------------------------------------------------- 宿主桩 */

const notifications = [];
const routes = new Map();
const tools = [];
let watchState = null;

const ctx = {
  get(name) {
    if (name === 'connection') {
      return {
        fetch: {
          register(handler) {
            routes.set(handler.path, handler);
            return () => routes.delete(handler.path);
          },
        },
      };
    }
    return undefined;
  },
  tools: {
    register(definition) {
      tools.push(definition);
      return () => {};
    },
  },
  effect() {
    return () => {};
  },
  on() {
    return () => {};
  },
};

mod.apply(ctx, {
  baseUrl: 'https://example.atlassian.net',
  email: 'me@example.com',
  apiToken: 'ATATT3xFfGF0offlineFixtureToken0000',
  projectKey: 'APP',
  maxResults: 50,
  timeoutMs: 4000,
  watchEnabled: true,
  watchIntervalMs: 15000,
  language: 'zh',
  onNotify: async (title, message) => { notifications.push({ title, message }); },
  onWatchState: (state) => { watchState = state; },
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const route = (path) => {
  const handler = routes.get(path);
  if (!handler) throw new Error(`路由没注册：${path}`);
  return handler;
};
const callWatch = async (method = 'GET') => {
  const response = await route('/api/jira-work-overview/state').fetch({
    method,
    url: `https://dsh.invalid/api/jira-work-overview/state?lang=zh`,
    json: async () => ({}),
    signal: undefined,
  });
  return response.json();
};
const callTransition = async (payload) => {
  const response = await route('/api/jira-work-overview/transition').fetch({
    method: 'POST',
    url: 'https://dsh.invalid/api/jira-work-overview/transition?lang=zh',
    json: async () => payload,
    signal: undefined,
  });
  return response.json();
};

check(Boolean(watchState) && typeof watchState.poll === 'function', 'onWatchState 钩子拿到了可手动推进的监视 state', typeof watchState?.poll);
if (!watchState) process.exit(1);

/* 1. 基线：只记不发 */
await watchState.poll();
check(watchState.baseline === true && notifications.length === 0, '首轮轮询只建基线，不通知', `notify=${notifications.length}`);
const baselineSeen = watchState.seen.get('APP-1')?.status;
check(baselineSeen === '开始', '基线记下了当前状态', String(baselineSeen));

/* 2. 别人改的状态：照常通知 */
issues.get('APP-1').status = 'IN QA';
issues.get('APP-1').category = 'indeterminate';
await watchState.poll();
const externalPending = await callWatch('GET');
check(notifications.length === 1, '别人改了状态 → 照常弹通知（对账没把它一起吞掉）', `${notifications.length} 条 / ${notifications[0]?.message}`);
check(
  (externalPending.watch?.counts?.status ?? 0) === 1 && watchState.seen.get('APP-1')?.status === 'IN QA',
  '未读角标记下这条别人的状态变化，基线推进到新状态',
  JSON.stringify(externalPending.watch?.counts),
);
await callWatch('POST'); // 面板「标记已读」

/* 3. 面板改自己的状态：静默吸收 */
const applied = await callTransition({ key: 'APP-1', transitionId: '41', from: 'IN QA', to: '已完成', category: 'done' });
check(applied.ok === true && applied.status === '已完成', ' 面板 POST 改状态成功并回读新状态', `${applied.status}/${applied.category}`);
await sleep(20);
await watchState.poll();
const afterSelf = await callWatch('GET');
check(notifications.length === 1, '自己改的状态 → 下一轮轮询不再通知', `${notifications.length} 条（仍是别人那一次的 1 条）`);
check(
  (afterSelf.watch?.counts?.total ?? -1) === 0 && watchState.seen.get('APP-1')?.status === '已完成',
  '状态改成 Done 后离开「未完成」查询，也不算「任务关闭」',
  `total=${afterSelf.watch?.counts?.total} seen=${watchState.seen.get('APP-1')?.status}`,
);

/* 4. 同事紧接着改成别的状态：期望值对不上，必须照常通知 */
issues.get('APP-1').status = 'Backlog';
issues.get('APP-1').category = 'new';
await watchState.poll();
check(notifications.length === 2, '同一个 issue 被同事改成别的状态 → 仍然通知（对账只吞自己那一次）', `${notifications.length} 条`);
check((await callWatch('GET')).watch?.counts?.status === 1, '这条别人的变化进未读角标', 'status=1');
await callWatch('POST');

/* 5. 工具 apply=true 走同一条对账路径 */
issues.get('APP-2').status = '开始';
issues.get('APP-2').category = 'new';
await watchState.poll(); // 把基线对齐到「开始」
await callWatch('POST');
const notifyBeforeTool = notifications.length;
const tool = tools.find((definition) => definition.name === 'jira_transition');
check(Boolean(tool), 'jira_transition 工具已注册', tool?.name);
const toolOutput = await tool.execute({ key: 'APP-2', to: '正在进行', apply: true }, {});
check(String(toolOutput).includes('正在进行'), '工具改状态成功', String(toolOutput).split('\n')[1]);
await sleep(20);
await watchState.poll();
check(notifications.length === notifyBeforeTool, '工具改的状态同样不通知（面板之外的另一条写入路径）', `${notifyBeforeTool} → ${notifications.length} 条`);
check(watchState.seen.get('APP-2')?.status === '正在进行', '基线推进到工具写入的新状态', String(watchState.seen.get('APP-2')?.status));

/* 6. 写失败不留残影：之后别人把它改成那个目标状态，仍然通知 */
const notifyBeforeFailed = notifications.length;
transitionFails = true;
const failedWrite = await callTransition({ key: 'APP-2', transitionId: '41', from: '正在进行', to: '已完成', category: 'done' });
check(failedWrite.ok === false, '写失败如实报错', String(failedWrite.error).slice(0, 30));
transitionFails = false;
issues.get('APP-2').status = '已完成';
issues.get('APP-2').category = 'done';
await watchState.poll();
check(notifications.length === notifyBeforeFailed + 1, '写失败后没有残留期望：别人改成那个状态仍然通知', `${notifyBeforeFailed} → ${notifications.length} 条`);

/* 7. 自己把一个 Done 的 issue 改回未完成：它重新出现在「未完成」查询里，也不该算「新指派」 */
const notifyBeforeReopen = notifications.length;
const reopenOutput = await tool.execute({ key: 'APP-2', to: 'Backlog', apply: true }, {});
check(String(reopenOutput).includes('Backlog'), '工具把 Done 的 issue 改回未完成', String(reopenOutput).split('\n')[1]);
await sleep(20);
await watchState.poll();
check(notifications.length === notifyBeforeReopen, '自己改回未完成的 issue 重新出现 → 不算新指派、不通知', `${notifyBeforeReopen} → ${notifications.length} 条`);
check(watchState.seen.get('APP-2')?.status === 'Backlog', '基线记下它的新状态', String(watchState.seen.get('APP-2')?.status));

/* 期望表不该越积越多：正常一轮轮询就消费掉，剩下的至多是在途的那一条 */
check(watchState.selfApplied.size === 0, '自己改的期望被消费干净（不会无限累积）', `size=${watchState.selfApplied.size}`);

console.log(failed === 0 ? '\n=== selfwatch：自己改的状态不再通知（含外部变化仍通知）全部通过 ===' : `\n=== selfwatch：${failed} 项失败 ===`);
process.exit(failed === 0 ? 0 : 1);
