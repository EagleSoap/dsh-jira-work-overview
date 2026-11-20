// 离线端到端：任务行的「计划」按钮 → host 的 /api/jira-work-overview/plan 通道 → 建一条 plan 模式的会话。
//
// 全程不联网：Jira、DSH 的 remote / workspace / agents 服务都用桩，但**跑的是真的 index.js 与 client.js**。
// 覆盖的正是需求本身：
//   1. 点「计划」在项目绑定的工作区里建会话，/plan 先于第一条消息；
//   2. 第一条消息只含「任务 + 汇报口径 + 规则」，且带 `JIRA_PLAN_SESSION:<KEY>` 标记；
//   3. 同一张卡再点一次不再新建（本地绑定命中；清掉本地配置后靠会话日志里的标记找回）；
//   4. 项目没绑工作区 / 没配 plan 模式 → 明确报错，一条会话都不建；
//   5. Jira 卡信息不全 → 首条消息里带「中断并告诉用户任务不明确」的指令，规划提示里也列出缺什么。
import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const TMP = process.env.DSH_JIRA_TMP || (existsSync(join('/tmp', '.dsh_jira_env')) ? '/tmp' : tmpdir());
const HOST_COPY = join(TMP, 'dsh-jira-plan', 'index.js');
mkdirSync(join(TMP, 'dsh-jira-plan'), { recursive: true });

const WS = dirname(dirname(fileURLToPath(import.meta.url)));
copyFileSync(`${WS}/index.js`, HOST_COPY);

/* host 半边 import @deepseek-ai/schemastery，那个包只活在 app.asar 里（真目录不能软链），
   所以照 dsh-jira-smoke3 的老做法整包**拷**到临时目录的 node_modules 下
   （DSH_INSTALL_DIR/package.json 的 dependencies 里就有它和它的依赖 cosmokit）。 */
const HOST_MODULES = join(TMP, 'dsh-jira-plan', 'node_modules', '@deepseek-ai');
for (const name of ['schemastery', 'cosmokit']) {
  const target = join(HOST_MODULES, name);
  if (existsSync(target)) continue;
  // 包目录不能靠 resolve（app.asar 里的 exports 会被 fs 的 asar 补丁挡掉）：
  // 锚点 `<root>/dsh/node_modules/@deepseek-ai/dsh` 往上一级就是依赖树 `<root>/dsh/node_modules/@deepseek-ai`。
  const root = join(process.env.DSH_INSTALL_DIR, '..', name);
  mkdirSync(target, { recursive: true });
  const fs = await import('node:fs');
  for (const entry of fs.readdirSync(root)) {
    const abs = join(root, entry);
    if (fs.statSync(abs).isDirectory()) copyTree(fs, abs, join(target, entry));
    else fs.copyFileSync(abs, join(target, entry));
  }
}
function copyTree(fs, from, to) {
  mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from)) {
    const abs = join(from, entry);
    if (fs.statSync(abs).isDirectory()) copyTree(fs, abs, join(to, entry));
    else fs.copyFileSync(abs, join(to, entry));
  }
}

let failed = 0;
const check = (ok, label, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : ` | ${detail}`}`);
  if (!ok) failed += 1;
};

/* ------------------------------------------------------------ 假 Jira */

const JIRA_ISSUES = {
  'APP-1': {
    key: 'APP-1',
    fields: {
      summary: '登录页加「记住我」',
      status: { name: 'To Do' },
      issuetype: { name: 'Story' },
      parent: { key: 'APP-0', fields: { summary: '账号体系' } },
      description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '勾选后 30 天内免登录。' }] }] },
      issuelinks: [],
    },
  },
  'APP-2': {
    // 信息不全：没标题、描述是空的 ADF、没有父任务也没有关联——正是要中断的那种卡。
    key: 'APP-2',
    fields: { summary: '', status: { name: 'To Do' }, issuetype: { name: 'Task' }, description: { type: 'doc', content: [] }, issuelinks: [] },
  },
};
const jiraCalls = [];

/* ------------------------------------------------------- host 侧服务桩 */

const settingsWrites = [];
/* 「删掉计划对话」走的是基座的归档通道：记录调用，必要时模拟基座拒收。 */
const archiveCalls = [];
let archiveRefuses = false;
const registeredRoutes = [];
let settingsRaw = {
  projectWorkspaces: 'APP\tws-uuid-1',
  planSessions: '',
};
const hostCtx = {
  get(name) {
    if (name === 'connection') {
      return { fetch: { register(route) { registeredRoutes.push(route); return () => {}; } } };
    }
    if (name === 'workspace') {
      return { async get(id) { return id === 'ws-uuid-1' ? { id, path: TMP, title: 'tmp' } : undefined; } };
    }
    if (name === 'remote') return remoteService;
    if (name === 'agents') return { list: () => sessions.map((session) => ({ id: session.id, session })) };
    if (name === 'workspaces') {
      // 回归护栏：插件不能直接取 `ctx.workspaces` —— 注册表在服务树上的名字是 `workspaceRegistry`，
      // 这个键本来就拿不到（真机上曾因此报 `no workspaces service`）。
      throw new Error('cannot get property "workspaces" without inject');
    }
    if (name === 'settings') {
      return {
        describe: () => [{ ns: 'jira-work-overview', revision: 1 }],
        async mutate(ns, ops) { settingsWrites.push({ ns, ops }); },
      };
    }
    return undefined;
  },
  tools: { register() {} },
};

/* 会话桩：只要 snapshotEvents 能按标记搜到第一条用户消息就够了。 */
const sessions = [];
const remoteCalls = [];
const remoteService = {
  // 基座的 archive 门面：真实现是 `remote.workspaces.archiveSession({ sessionId, stopActivity })`，
  // 把 registry 的错误翻成 `session/not-found` / `workspace/session-active` 两个码。
  workspaces: {
    async archiveSession(request) {
      const sessionId = request?.sessionId;
      archiveCalls.push({ sessionId, stopActivity: request?.stopActivity === true });
      if (archiveRefuses) {
        const error = new Error(`cannot archive session '${sessionId}'`);
        error.code = 'workspace/session-active';
        throw error;
      }
      return { archivedSessionIds: archiveCalls.map((call) => call.sessionId) };
    },
  },
  session: {
    async create({ workspaceId }) {
      remoteCalls.push({ call: 'create', workspaceId });
      const id = `sess-${sessions.length + 1}`;
      return { sessionId: id };
    },
    commands: {
      async execute(sessionId, name, args) {
        remoteCalls.push({ call: 'command', sessionId, name, args });
        return { ok: true, value: { commandId: 'plan', result: { kind: 'success', text: '' } } };
      },
    },
    async prompt(request, source) {
      remoteCalls.push({ call: 'prompt', requestId: request.requestId, sessionId: request.sessionId, text: request.content[0]?.text, source });
      // 真宿主在这里落一条 user/message 事件；桩里落一份同样内容，供「按标记搜会话日志」用。
      sessions.push({
        id: request.sessionId,
        snapshotEvents: () => [{ type: 'user/message', data: { content: request.content } }],
      });
      return { accepted: true };
    },
  },
};
/* create 之后才出现在 agents.list() 里（宿主侧 agent 是异步注册的）。 */
const createProbe = remoteService.session.create;
remoteService.session.create = async (request) => {
  const created = await createProbe(request);
  sessions.push({ id: created.sessionId, snapshotEvents: () => [] });
  return created;
};

process.env.DSH_JIRA_LANG = 'zh';
const host = await import(pathToFileURL(HOST_COPY).href);
host.apply(hostCtx, host.Config({
  baseUrl: 'https://example.atlassian.net',
  email: 'you@example.com',
  apiToken: 'ATATT3xFfGF0FAKEFAKEFAKE',
  projectKey: 'APP',
  boardId: 42,
  maxResults: 50,
  timeoutMs: 30000,
  watchEnabled: false,
}));

const planRoute = registeredRoutes.find((route) => route.path === '/api/jira-work-overview/plan');
check(Boolean(planRoute), 'host 注册了 /api/jira-work-overview/plan 通道', registeredRoutes.map((r) => r.path).join(', '));

/* 配置的读写都走 volatile 引用：这里用 get/set 模拟 Loader 提交后的值。 */
const liveValue = (key, fallback) => (settingsRaw[key] !== undefined ? { get: () => settingsRaw[key] } : fallback);
const hostConfigView = {
  get projectWorkspaces() { return liveValue('projectWorkspaces', ''); },
  get planSessions() { return liveValue('planSessions', ''); },
};

/* host 的 jira.get 需要真 Jira：用 global fetch 桩顶住（与其它离线套件同一手法）。 */
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const text = String(url);
  jiraCalls.push(text);
  const hit = /\/rest\/api\/3\/issue\/([A-Z0-9-]+)/.exec(text);
  if (!hit) return new Response(JSON.stringify({ errorMessages: ['unexpected'] }), { status: 404 });
  const issue = JIRA_ISSUES[hit[1]];
  return new Response(JSON.stringify(issue ?? {}), { status: issue ? 200 : 404, headers: { 'content-type': 'application/json' } });
};

/* 让 jira 读到的映射就是 settingsRaw：路由用 liveSetting(settings)，这里把默认配置替换成活的引用。 */
const planPayload = async (payload) => {
  const response = await planRoute.fetch({ method: 'POST', url: 'http://dsh.invalid/api/jira-work-overview/plan', json: async () => payload });
  return response.json();
};

/* 配置里的 planSessions 由 writeSettings → settings.mutate 写入：记录后同步到 settingsRaw，模拟回读。 */
settingsWrites.forEach(() => {});
const syncWrites = () => {
  while (settingsWrites.length) {
    const write = settingsWrites.shift();
    for (const op of write.ops) if (op.path[0] === 'planSessions') settingsRaw.planSessions = op.value;
  }
};

/* 真路由读的是 apply() 里那份 config（默认空串）：用 mutate 落一次初始值，让第一次读就有映射。 */
await hostCtx.get('settings').mutate('jira-work-overview', [{ op: 'set', path: ['planSessions'], value: '' }]);
settingsWrites.length = 0;

/* ------------------------------------------------------------- 场景 1 */

const created = await planPayload({ action: 'create', issue: 'APP-1', workspaceId: 'ws-uuid-1', policy: '', instruction: '任务：APP-1 登录页加「记住我」' });
syncWrites();
console.log('\n场景 1（首次点「计划」）');
console.log('  返回:', JSON.stringify({ ok: created.ok, sessionId: created.sessionId, gaps: created.gaps, persisted: created.persisted }));
check(created.ok === true && Boolean(created.sessionId), '建出一条计划对话', created.sessionId);
const order = remoteCalls.map((call) => call.call);
check(order.indexOf('command') >= 0 && order.indexOf('command') < order.indexOf('prompt'), '/plan 先于第一条消息', order.join(' → '));
const firstText = remoteCalls.find((call) => call.call === 'prompt')?.text ?? '';
console.log('  首条消息:\n' + firstText.split('\n').map((line) => `    ${line}`).join('\n'));
check(firstText.startsWith('JIRA_PLAN_SESSION:APP-1'), '首条消息带任务标记（供会话日志兜底索引）');
check(/只汇报/.test(firstText), '首条消息带「只汇报修改任务、不写解释」的口径');
check(/不明确/.test(firstText), '首条消息带「Jira 卡不明确就中断」的规则');
check(Array.isArray(created.gaps) && created.gaps.length === 0, '信息齐全的卡没有 gaps', JSON.stringify(created.gaps));
/* ------------------------------------------------------------- 场景 2 */

/* ------------------------------------------------------------- 场景 3 */

const searched = await planPayload({ action: 'search', issue: 'APP-1' });
syncWrites();
console.log('\n场景 2（同一张卡再点一次 / 换浏览器后点）');
console.log('  search →', JSON.stringify({ sessionId: searched.sessionId, bound: searched.bound }));
check(searched.sessionId === created.sessionId, '按会话日志里的标记找回同一条计划对话', searched.sessionId);

const callsBefore = remoteCalls.filter((call) => call.call === 'create').length;
const again = await planPayload({ action: 'link', issue: 'APP-1', sessionId: created.sessionId });
syncWrites();
check(again.ok === true, 'link 幂等（重复绑定同一条会话）', JSON.stringify(again.sessions ?? {}));
check(remoteCalls.filter((call) => call.call === 'create').length === callsBefore, '重复绑定不会新建会话', String(callsBefore));

/* ------------------------------------------------------------- 场景 4 */

const unclear = await planPayload({ action: 'create', issue: 'APP-2', workspaceId: 'ws-uuid-1', policy: '', instruction: '' });
syncWrites();
console.log('\n场景 3（信息不全的卡）');
console.log('  gaps:', JSON.stringify(unclear.gaps));
check(Array.isArray(unclear.gaps) && unclear.gaps.length >= 3, '列出缺口（标题 / 描述 / 上下文）', JSON.stringify(unclear.gaps));
const unclearText = remoteCalls.filter((call) => call.call === 'prompt').map((call) => call.text).find((text) => text.includes('APP-2')) ?? '';
check(/不明确/.test(unclearText) && /缺/.test(unclearText), '首条消息要求中断并说明缺什么', unclearText.split('\n').filter((line) => /不明确|缺/.test(line)).join(' / '));

/* ------------------------------------------------------------- 删掉计划对话 */

// 归档先失败：绑定必须原样留着，否则面板会以为没计划过、再点又开一条新的。
archiveRefuses = true;
const refused = await planPayload({ action: 'drop', issue: 'APP-1' });
syncWrites();
console.log('\n场景 5（删掉已绑定的计划对话）');
check(refused.ok === false && /归档|archive/i.test(String(refused.error)), '归档失败 → 明确报错', refused.error);
check(String(settingsRaw.planSessions).includes('APP-1'), '归档失败时绑定保留（卡片仍显示已绑定）', JSON.stringify(settingsRaw.planSessions));

archiveRefuses = false;
const dropped = await planPayload({ action: 'drop', issue: 'APP-1' });
syncWrites();
check(dropped.ok === true, '归档成功 → 返回 ok', JSON.stringify({ ok: dropped.ok, sessionId: dropped.sessionId }));
check(archiveCalls.some((call) => call.sessionId === created.sessionId && call.stopActivity === true), '用基座 remote.workspaces.archiveSession 归档（带 stopActivity）', JSON.stringify(archiveCalls.slice(-1)));
check(!String(settingsRaw.planSessions).includes('APP-1'), '归档后绑定被删除（卡片回到未计划）', JSON.stringify(settingsRaw.planSessions));
const dropAgain = await planPayload({ action: 'drop', issue: 'APP-1' });
check(dropAgain.ok === false && /绑定|bound/i.test(String(dropAgain.error)), '对没绑定的卡再删 → 明确报错', dropAgain.error);

/* ------------------------------------------------------------- 场景 5 */

const noWorkspace = await planPayload({ action: 'create', issue: 'APP-1' });
const badAction = await planPayload({ action: 'nope', issue: 'APP-1' });
const badKey = await planPayload({ action: 'link', issue: 'not-a-key', sessionId: 'x' });
console.log('\n场景 4（参数错误）');
check(noWorkspace.ok === false && /工作区/.test(noWorkspace.error), '缺工作区 id → 明确报错', noWorkspace.error);
check(badAction.ok === false && /plan/.test(String(badAction.error)) === false && /操作|action/i.test(String(badAction.error)), '不支持的动作 → 明确报错', badAction.error);
check(badKey.ok === false && /issue|key|APP-3489/i.test(String(badKey.error)), '非法 issue key → 明确报错', badKey.error);

/* ------------------------------------------------------------- client 侧 */

const hookStore = new Map();
let currentComponent = '';
let hookIndex = 0;
const flatten = (list) => list.flat(Infinity).filter((item) => item !== null && item !== undefined && item !== false && item !== true);
const createElement = (type, props, ...children) => ({ type, props: props ?? {}, children: flatten(children) });
function slot(index) {
  let list = hookStore.get(currentComponent);
  if (!list) { list = []; hookStore.set(currentComponent, list); }
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
    const changed = cell.deps === undefined || !deps || deps.length !== cell.deps.length || deps.some((dep, i) => dep !== cell.deps[i]);
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
  const queue = [node];
  while (queue.length) {
    const row = queue.pop();
    visit(row);
    const children = row.children ?? [];
    for (let i = children.length - 1; i >= 0; i -= 1) queue.push(children[i]);
  }
}
function collectText(node) {
  let out = '';
  walk(node, (row) => { if (row.type === '#text') out += row.text; });
  return out;
}

/* 面板文案：语言服务的桩只需要这几个键（缺键会原样返回，断言就抓得到）。 */
const M = {
  zh: {
    planButton: '计划',
    planDrop: '删除这条计划对话',
    planDropped: '{key} 的计划对话已删除',
    planBusy: '该任务正在建计划对话…',
    planNoWorkspace: '项目 {project} 还没有绑定工作区',
    planCreated: '已为 {key} 建好计划对话',
    planOpened: '{key} 已有计划对话，已为你打开',
    planIssueLine: '任务：{key} {summary}\n链接：{url}',
    planRules: '要求：\n1. 只汇报「将要执行的修改任务」\n5. 必须调用一次 ask_user_question，问题「按这份计划开始执行吗？」，选项「按这份计划执行」与「我要修改计划」',
  },
};

/* 假 DOM / 假 transport 都做成普通对象：class 写成箭头函数属性，不涉及任何原型链。 */
const styleTags = [];
const fakeDocument = {
  head: { appendChild: (tag) => styleTags.push(tag) },
  body: {},
  activeElement: undefined,
  createElement: (tag) => ({ tagName: tag, dataset: {}, style: {}, textContent: '', remove: () => {} }),
  querySelector: (selector) => styleTags.find((tag) => selector.includes(tag.dataset.pluginCss)) ?? null,
  addEventListener: () => {},
  removeEventListener: () => {},
};
Object.defineProperty(globalThis, 'document', { value: fakeDocument, configurable: true });
Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true });

const clientRoutes = [];
const clientJobs = [];
const clientPlanSessions = { sessions: {} };
/* 面板点「×」后应当走 host 的 drop：这里记下被删掉的会话 id。 */
const clientArchived = [];
/* 面板看到的那批卡片；后面加一张，验证「没装 plan 模式插件」时的二次点击。 */
const clientListItems = [{
  key: 'APP-1', project: 'APP', summary: '登录页加「记住我」', status: 'To Do', category: 'new',
  type: 'Story', priority: '', sprintId: null, sprint: '', due: '', updated: '2026-11-19',
  labels: [], parent: '', parentKey: '', parentSummary: '', epicKey: '', epicSummary: '',
  url: 'https://example.atlassian.net/browse/APP-1',
}];
const loaded = [];
const fakeWindow = {
  __ModuleLoader__: { load: (spec) => { loaded.push(spec); } },
  __DSH_TRANSPORT__: {
    fetch: async (url, init) => {
      const path = String(url).split('?')[0];
      clientRoutes.push({ path, method: String(init?.method ?? 'GET').toUpperCase(), body: init?.body ? JSON.parse(init.body) : null });
      const json = (payload) => ({ ok: true, status: 200, async json() { return payload; } });
      if (path === '/api/jira-work-overview/project-workspace') return json({ ok: true, mapping: { APP: ['ws-uuid-1'] }, workspaces: { 'ws-uuid-1': ['APP'] }, items: [] });
      // 映射的 GET：真 host 每次都给当前状态（删掉之后就是空的），别让面板残留旧的绑定。
      if (path === '/api/jira-work-overview/plan' && String(init?.method ?? 'GET').toUpperCase() === 'GET') {
        return json({ ok: true, sessions: { ...clientPlanSessions.sessions } });
      }
      if (path === '/api/jira-work-overview/plan') {
        // 真 host 的每次回应都带着当前映射：这里照着做（link 之后 APP-1 就绑到 sess-client-1）。
        const body = init?.body ? JSON.parse(init.body) : {};
        if (body.action === 'link' && body.sessionId) clientPlanSessions.sessions[body.issue] = body.sessionId;
        // drop = 基座归档会话 + 删掉绑定（真 host 的顺序：先归档、后解绑）。
        if (body.action === 'drop' && clientPlanSessions.sessions[body.issue]) {
          clientArchived.push(clientPlanSessions.sessions[body.issue]);
          delete clientPlanSessions.sessions[body.issue];
        }
        // `force: true` = 面板自己都没有这条绑定了（刚删掉 / 换过浏览器）：宿主只回映射、不翻日志。
        if (body.action === 'search' && body.force === true) {
          return json({ ok: true, sessions: { ...clientPlanSessions.sessions }, sessionId: '', bound: clientPlanSessions.sessions[body.issue] ?? '' });
        }
        const bound = clientPlanSessions.sessions[body.issue];
        return json({ ok: true, sessions: { ...clientPlanSessions.sessions }, sessionId: bound ?? '' });
      }
      // 角标长轮询：像真宿主那样压久一点再回，否则循环空转会把事件循环饿死。
      await new Promise((resolve) => setTimeout(resolve, 200));
      return json({ ok: true, watch: { enabled: true, counts: { new: 0, status: 0, closed: 0, total: 0 }, changes: [] } });
    },
  },
};
Object.defineProperty(globalThis, 'window', { value: fakeWindow, configurable: true });

/* profile 里的 plan 模式 section：模拟「装了 dsh-plan-mode 插件」；设成空串就是没装。 */
let profilePlanSection = '你在 plan 模式：先规划，用户敲定后再执行。';

/* 客户端上下文：remote.session 走真路（建会话 + /plan + prompt），并留下调用记录。 */
const clientRemoteCalls = [];
/* 会话对象层（对应基座的 `sessions` 服务）：面板只准走这里建会话 / 发命令 / 投消息。 */
let clientSessionSeq = 0;
const clientSessionsService = {
  list: { getSnapshot: () => ({ byId: { 'sess-main': { id: 'sess-main', retainedBy: { mainView: 1 } } } }) },
  async create(request) {
    clientRemoteCalls.push({ call: 'create', ...request });
    clientSessionSeq += 1;
    return `sess-client-${clientSessionSeq}`;
  },
  async using(sessionId, options, operation) {
    clientRemoteCalls.push({ call: 'using', sessionId, source: options?.source });
    const session = {
      async command(line) {
        clientRemoteCalls.push({ call: 'command', sessionId, name: line });
        return { ok: true, value: { matched: true } };
      },
      async prompt(content, mode, signal, requestId) {
        clientRemoteCalls.push({ call: 'prompt', sessionId, content, mode, requestId });
        return { ok: true, value: { accepted: true } };
      },
    };
    return operation({ sessionId, binding: { sessionId, session } });
  },
};
const clientOpened = [];
const clientCtx = {
  get(name) {
    if (name === 'remote.commands') {
      return {
        async execute(sessionId, line) {
          clientJobs.push(String(line));
          // 面板列表：固定返回一条卡在 APP 项目下（不联网）。
          return {
            ok: true,
            value: {
              commandId: 'jira',
              result: {
                kind: 'success',
                text: JSON.stringify({
                  ok: true,
                  generatedAt: '2026-11-20T00:00:00.000Z',
                  query: { scope: 'all', jql: 'x' },
                  project: 'APP',
                  counts: { new: clientListItems.length, indeterminate: 0, done: 0, total: clientListItems.length },
                  total: clientListItems.length,
                  projectTotals: { APP: clientListItems.length },
                  status: '',
                  statusOptions: [],
                  notes: [],
                  items: clientListItems.map((row) => ({ ...row })),
                  sprints: [{ id: null, name: '无迭代', state: '', start: '', end: '', active: false, keys: clientListItems.map((row) => row.key), counts: { new: clientListItems.length, indeterminate: 0, done: 0, total: clientListItems.length } }],
                }),
              },
            },
          };
        },
      };
    }
    if (name === 'remote') {
      // 回归护栏：面板不该去取 `remote.session` —— 插件没在 ctx.inject 里声明 remote，
      // 真机上这会直接抛 `cannot get property "remote.session" without inject`。
      return {
        get session() {
          throw new Error('cannot get property "remote.session" without inject');
        },
      };
    }
    if (name === 'uiWorkspace') return { openSession(id) { clientOpened.push(id); } };
    if (name === 'settings') {
      // 装了 plan 模式就在 profile patch 里配了 section（面板读它就知道该按什么口径规划）。
      return {
        get: (ns) => (ns === 'deepseek-ai/dsh-plan-mode' && profilePlanSection
          ? { config: { section: profilePlanSection } }
          : undefined),
      };
    }
    if (name === 'locale') {
      return {
        register() {},
        bind: () => (key, params) => {
          // 基座的语言服务：只把 store 里有的键翻出来，缺键原样返回（面板自己会回退到 M 字典）。
          const text = M.zh[key];
          if (typeof text !== 'string') return key;
          return params ? text.replace(/\{(\w+)\}/g, (all, name2) => (params[name2] === undefined ? all : String(params[name2]))) : text;
        },
        getSnapshot: () => ({ active: 'zh' }),
      };
    }
    if (name === 'sessions') return clientSessionsService;
    if (name === 'workspaces') return { list: { getSnapshot: () => ({ items: [{ workspaceId: 'ws-uuid-1', sessionIds: ['sess-main'] }] }) } };
    return undefined;
  },
  on() { return () => {}; },
  effect(fn) { const off = fn(); return () => { if (typeof off === 'function') off(); }; },
  slots: { inject(name, factory) { factory(); }, register() { return () => {}; } },
};

await import(pathToFileURL(`${WS}/client.js`).href);
const spec = loaded[0];
const clientMod = spec.factory((name) => {
  if (name === 'react') return React;
  if (name === 'react-dom') return { createPortal: (node) => node };
  if (name === '@tanstack/react-virtual') {
    return {
      useVirtualizer: (options) => {
        const count = Math.max(0, Number(options?.count) || 0);
        const items = Array.from({ length: count }, (_, index) => ({ index, key: index, start: index * 32, size: 32 }));
        return { getTotalSize: () => count * 32, getVirtualItems: () => items, measureElement() {}, scrollToIndex() {} };
      },
    };
  }
  return undefined;
});

/* 面板的槽组件只有在 register 时拿得到：换一个收集器再 apply 一次。 */
const registered = [];
clientCtx.slots = { inject(name, factory) { factory(); }, register(options, component) { registered.push({ options, component }); return () => {}; } };
clientMod.apply(clientCtx);
const panel = registered.find((row) => row.options.id === 'jira-work-overview-panel')?.component;
check(Boolean(panel), 'client 注册了面板槽组件', registered.map((row) => row.options.id).join(', '));

const render = () => {
  currentComponent = 'Panel';
  hookIndex = 0;
  return expand(createElement(panel, {}));
};
/* 等到面板真的画出那条任务（命令执行完 → 载荷落地 → 重渲染），而不是死等固定时长。 */
const settle = async (predicate) => {
  for (let i = 0; i < 80; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    if (predicate && predicate()) return true;
  }
  return !predicate;
};
/* 面板打开：点侧栏入口组件。 */
const entry = registered.find((row) => row.options.id === 'jira-work-overview')?.component;
currentComponent = 'Entry';
hookIndex = 0;
const entryTree = expand(createElement(entry, { wide: true }));
collectButtons(entryTree)[0]?.props?.onClick?.();
function collectButtons(node) {
  const hits = [];
  walk(node, (row) => { if (row.type === 'button') hits.push(row); });
  return hits;
}
/* 只看「计划」本体：已绑定的行后面还有一个「删掉计划对话」的小叉（`act plan-drop`），不能算进来。 */
const planButtonsOf = (node) => collectButtons(node).filter((row) => /\bact plan\b(?!-)/.test(String(row.props.className ?? '')));
let tree = render();
for (let i = 0; i < 60 && planButtonsOf(tree).length === 0; i += 1) {
  await new Promise((resolve) => setTimeout(resolve, 25));
  tree = render();
}
console.log('\nclient 半边');
const planButtons = planButtonsOf(tree);
check(planButtons.length === 1, '每条任务行末尾都有一个「计划」按钮', String(planButtons.length));
check(collectText(planButtons[0] ?? { children: [] }).includes('计划'), '按钮文案是「计划」', collectText(planButtons[0] ?? { children: [] }));

const before = clientRemoteCalls.length;
await planButtons[0].props.onClick({ preventDefault() {}, stopPropagation() {} });
await settle(() => clientRemoteCalls.some((call) => call.call === 'prompt'));
/* 绑定是面板等 host 回执之后才落到 plans.sessions 的：再多转几圈直到按钮变成 on。 */
for (let i = 0; i < 40 && !String(planButtonsOf(render())[0]?.props?.className ?? '').includes(' on'); i += 1) {
  await new Promise((resolve) => setTimeout(resolve, 25));
}
tree = render();
const clientOrder = clientRemoteCalls.slice(before).map((call) => call.call);
console.log('  client 调用顺序:', clientOrder.join(' → '));
check(clientOrder[0] === 'create', '先在绑定的工作区建会话', JSON.stringify(clientRemoteCalls.slice(before)[0]));
check(clientOrder.includes('command') && clientOrder.indexOf('command') < clientOrder.indexOf('prompt'), '/plan 先于任务消息');
const clientPrompt = clientRemoteCalls.slice(before).find((call) => call.call === 'prompt');
check(Boolean(clientPrompt?.requestId), 'prompt 带 requestId（宿主据此去重）', clientPrompt?.requestId);
check(String(clientPrompt?.content?.[0]?.text ?? '').startsWith('JIRA_PLAN_SESSION:APP-1'), '面板投递的首条消息同样带任务标记');
check(clientOpened.includes('sess-client-1'), '建好后在主视图打开它', clientOpened.join(','));

/* 已绑定的行后面多一个「×」：点它 = 走 host 的 drop（归档 + 解绑）。 */
const dropButton = () => collectButtons(render()).find((row) => /act plan-drop/.test(String(row.props?.className ?? '')));
check(Boolean(dropButton()), '已绑定的任务行有「删掉计划对话」按钮', dropButton()?.props?.className);
await dropButton()?.props?.onClick?.({ preventDefault() {}, stopPropagation() {} });
/* 等的是面板自己那一步落定（按钮变回未绑定的样子），不是等映射文件——映射在点下去那一刻就清了。 */
for (let i = 0; i < 60 && Boolean(dropButton()); i += 1) {
  await new Promise((resolve) => setTimeout(resolve, 25));
}
/* 再点「计划」：删除时那条会话带着刚落下的提示，先等它完全静止，别和新建抢同一个 busy。 */
await settle(() => false);
const dropCall = [...clientRoutes].reverse().find((row) => row.path === '/api/jira-work-overview/plan' && row.body?.action === 'drop');
check(Boolean(dropCall) && dropCall.body.issue === 'APP-1', '点「×」走 host 的 drop（归档那条会话并解绑）', JSON.stringify(dropCall?.body ?? null));
check(clientArchived.includes('sess-client-1'), '被删的是原来那条计划对话', clientArchived.join(','));
// 删完要能重新计划：再点一次「计划」应当新建一条（而不是打开已归档的那条）。
const beforeRecreate = clientRemoteCalls.filter((call) => call.call === 'create').length;
await planButtonsOf(render())[0].props.onClick({ preventDefault() {}, stopPropagation() {} });
for (let i = 0; i < 60 && clientRemoteCalls.filter((call) => call.call === 'create').length === beforeRecreate; i += 1) {
  await new Promise((resolve) => setTimeout(resolve, 25));
}
const createdAfter = clientRemoteCalls.filter((call) => call.call === 'create').length;
check(createdAfter > beforeRecreate, '删掉之后再点「计划」是新建一条，不是打开旧的', `${beforeRecreate} → ${createdAfter} | 归档 ${clientArchived.join(',')}`);
// 收尾：把这条也删掉，后面「没装 plan 模式」的场景从「未绑定」开始。
await collectButtons(render()).find((row) => /act plan-drop/.test(String(row.props?.className ?? '')))?.props?.onClick?.({ preventDefault() {}, stopPropagation() {} });
for (let i = 0; i < 60 && Object.keys(clientPlanSessions.sessions).length > 0; i += 1) {
  await new Promise((resolve) => setTimeout(resolve, 25));
}

const planButtonNow = planButtonsOf(tree)[0];
check(String(planButtonNow?.props?.className ?? '').includes(' on'), '该任务已经有计划对话 → 按钮标成已绑定（on）');
const firstPlanText = String(clientPrompt?.content?.[0]?.text ?? '');
check(firstPlanText.includes(profilePlanSection), '首条消息带上 profile 里配的 plan 模式口径', firstPlanText);
// 计划列完之后要交给用户一键确认：用原生问答工具收尾，而不是让用户自己组织一段回复。
check(firstPlanText.includes('ask_user_question') && firstPlanText.includes('按这份计划执行'), '首条消息要求用 ask_user_question 收尾，提供「执行 / 要改」两个选项', firstPlanText.split('\n').filter((line) => /ask_user_question/.test(line)).join(' / ').slice(0, 160));


/* ------------------------------------------------ 没装 dsh-plan-mode 的 profile */
// 面板是插件自己的功能：profile 里没有 plan 模式插件时，也要能开计划对话——
// 口径由首条消息自带的 NO_POLICY_POLICY 兜底，而不是弹一句「没配 plan 模式」就作罢。
// profile 换成「只有 dsh-plan-mode 之外的行」，并重新 apply 一次（语言服务换了绑定）。
profilePlanSection = '';
globalThis.__DSH_BOOT__ = { patch: { insert: [{ id: 'jira-work-overview', name: 'dsh-jira-work-overview' }] } };
clientListItems.push({
  key: 'APP-3', project: 'APP', summary: '导出 CSV', status: 'To Do', category: 'new',
  type: 'Task', priority: '', sprintId: null, sprint: '', due: '', updated: '2026-11-19',
  labels: [], parent: '', parentKey: '', parentSummary: '', epicKey: '', epicSummary: '',
  url: 'https://example.atlassian.net/browse/APP-3',
});
clientMod.apply(clientCtx);
/* 列表是靠面板标题栏的「刷新」重新拉的（与用户手动刷新同一个入口）：点它，第二张卡就进列表了。 */
const refreshButton = () => collectButtons(render()).find((row) => row.props?.title === '刷新');
check(Boolean(refreshButton()), '面板标题栏有「刷新」按钮', refreshButton()?.props?.title);
refreshButton()?.props?.onClick?.();
await settle(() => false);
let rows = planButtonsOf(render());
for (let i = 0; i < 120 && rows.length < 2; i += 1) {
  await new Promise((resolve) => setTimeout(resolve, 25));
  rows = planButtonsOf(render());
}
check(rows.length === 2, '列表里出现了第二条可点的「计划」', String(rows.length));
if (rows.length >= 2) {
  const callsBefore = clientRemoteCalls.length;
  await rows[1].props.onClick({ preventDefault() {}, stopPropagation() {} });
  await settle(() => clientRemoteCalls.slice(callsBefore).some((call) => call.call === 'prompt'));
  const fresh = clientRemoteCalls.slice(callsBefore);
  const noPolicyPrompt = fresh.find((call) => call.call === 'prompt');
  const noPolicyText = String(noPolicyPrompt?.content?.[0]?.text ?? '');
  check(fresh[0]?.call === 'create', '没装 plan 模式插件也照样建出计划对话（不再被前置校验挡住）', fresh.map((call) => call.call).join(' → '));
  check(noPolicyText.includes('plan 模式') && noPolicyText.includes('只汇报'), '首条消息自带 plan 口径兜底', noPolicyText.split('\n').filter((line) => /plan 模式|只汇报/.test(line)).join(' / '));
}

globalThis.fetch = realFetch;
console.log(failed === 0 ? '\n=== 计划对话测试：全部通过 ===' : `\n=== 计划对话测试：${failed} 项失败 ===`);
process.exit(failed === 0 ? 0 : 1);
