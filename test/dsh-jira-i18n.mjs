/**
 * 国际化（zh / en）端到端测试。
 *
 * 只做两件事：
 *   A. host 半边：同一份假 Jira 数据，在 zh / en 两种语言下渲染 —— 断言「插件的文案跟着语言换」，
 *      而「Jira 返回的数据」（中文摘要、`In Review` 这种状态名）**逐字不变**。
 *      语言的三个来源都覆盖：DSH_JIRA_LANG 环境变量、`--lang=` 操作覆盖、Config 的 `language`。
 *   B. client 半边：把我们的字典注册进 ctx.locale，并订阅 locale/change（切语言要能重渲染）。
 *
 * 用法：ELECTRON_RUN_AS_NODE=1 "$BIN" test/dsh-jira-i18n.mjs
 */
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TMP = process.env.DSH_JIRA_TMP || (existsSync(join('/tmp', '.dsh_jira_env')) ? '/tmp' : tmpdir());
const HOST_COPY = join(TMP, 'dsh-jira-smoke3', 'index.js');
// 项目目录名里带空格（`dsh plugins`），必须走 fileURLToPath：URL.pathname 会把空格转成 %20，复制文件就 ENOENT。
const WS = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
mkdirSync(join(TMP, 'dsh-jira-smoke3'), { recursive: true });
copyFileSync(join(WS, 'index.js'), HOST_COPY);
// patch 文件真的建出来：settings GET 才会回 patchExists=true，面板上的按钮才不是禁用的。
const PATCH_FILE = join(TMP, 'dsh-jira-smoke3', 'cordis.patch.yml');
if (!existsSync(PATCH_FILE)) writeFileSync(PATCH_FILE, '# cordis patch（i18n 测试用）\n');

const CJK = /[\u4e00-\u9fff]/;
const results = [];
const check = (label, value, extra = '') => {
  results.push(value === true);
  console.log(`${value === true ? 'PASS' : 'FAIL'}  ${label}${extra ? ` | ${extra}` : ''}`);
};

/* ---------------------------------------------------- 假 Jira 数据 */

const SUMMARY = '網上APP入會，電郵地址默認值';
const PARENT = '【APP】商品模块';
const STATUS = 'In Review';
const RECORD = {
  key: 'APP-4051',
  fields: {
    summary: SUMMARY,
    status: { name: STATUS, statusCategory: { key: 'indeterminate', name: '进行中' } },
    issuetype: { name: '故事' },
    priority: { name: 'High' },
    parent: { key: 'APP-1948', fields: { summary: PARENT } },
    labels: ['需求优化'],
    updated: '2026-11-18T11:02:00.000+0800',
    duedate: null,
    customfield_10020: [{ id: 811, name: 'APP Sprint 26', state: 'active', startDate: '2026-10-09T16:00:39.000Z', endDate: '2026-10-25T15:30:00.000Z' }],
  },
};

/* 翻页桩：natural = 一页 isLast（其它断言用的默认值）；many = 3 页后 isLast；
   infinite = 永远给 nextPageToken（验证 50 页安全上限）；slow = 第 2 页卡住（验证 timeoutMs 总超时）。
   每页按请求的 maxResults 给条目；slow 模式会监听 abort，模拟真 fetch 被总超时掐断。 */
const paging = { mode: 'natural', pages: 0 };
const pageItems = (page, count) => Array.from({ length: count }, (_, index) => ({
  key: `APP-P${page}-${index}`,
  id: `${page}${index}`,
  fields: { ...RECORD.fields },
}));
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  if (signal) {
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }));
    }, { once: true });
  }
});

const json = (body, status = 200) => ({
  ok: status < 400,
  status,
  async text() { return JSON.stringify(body); },
});

Object.defineProperty(globalThis, 'fetch', {
  configurable: true,
  writable: true,
  value: async (url, init) => {
    const target = String(url);
    if (target.includes('/rest/api/3/field')) {
      return json([{ id: 'customfield_10020', name: '冲刺', schema: { custom: 'com.pyxis.greenhopper.jira:gh-sprint' } }]);
    }
    if (target.includes('/rest/api/3/search/jql')) {
      if (paging.mode === 'natural') return json({ issues: [RECORD], isLast: true });
      paging.pages += 1;
      const want = Number(new URL(target).searchParams.get('maxResults')) || 100;
      const batch = pageItems(paging.pages, Math.min(100, Math.max(1, want)));
      if (paging.mode === 'slow') {
        // 第 2 页开始卡住：真 fetch 会在总超时（AbortSignal）到点时被掐断。
        if (paging.pages > 1) await sleep(1500, init?.signal);
        return json({ issues: batch, nextPageToken: `tok-${paging.pages}` });
      }
      const token = { nextPageToken: `tok-${paging.pages}` };
      if (paging.mode === 'many' && paging.pages >= 3) return json({ issues: batch, isLast: true });
      return json({ issues: batch, ...token });
    }
    // 面板的「共 N 项」走这个端点：只回一个 count（真实站点实测与翻页拉全集一致）。
    if (target.includes('/rest/api/3/search/approximate-count')) {
      // 真站点会对非法 JQL 回 400：项目条件必须加在 ORDER BY 之前——桩也照着校验，
      // 否则「拼接顺序写错」这种 bug 在测试里看不出来（本机实测踩过）。
      const body = JSON.parse(String(init?.body ?? '{}'));
      // 状态筛选（status = "..."）也必须插在 ORDER BY 之前，桩一起校验。
      if (/ORDER\s+BY[\s\S]*\b(project|status)\s*=/i.test(String(body.jql ?? ''))) {
        return json({ errorMessages: ['Invalid JQL: the ORDER BY clause must be the last one'] }, 400);
      }
      return json({ count: 9 });
    }
    if (target.includes('/rest/agile/1.0/board/')) {
      return json({ values: [{ id: 811, name: 'APP Sprint 26', state: 'active', startDate: '2026-10-09T16:00:39.000Z', endDate: '2026-10-25T15:30:00.000Z' }] });
    }
    if (target.includes('/rest/api/3/issue/') && target.includes('/transitions')) {
      return json({ transitions: [{ id: '81', name: 'Start', to: { name: 'IN QA', statusCategory: { key: 'indeterminate' } }, fields: {} }] });
    }
    if (target.includes('/rest/api/3/issue/')) {
      return json({ key: RECORD.key, fields: RECORD.fields });
    }
    return json({});
  },
});

/* ---------------------------------------------------- host 半边 */

const store = new Map([['JIRA_API_TOKEN', 'ATATT3xFfGF0TOKEN00000000000000000000000000000000001DB8F000']]);
const CRED = ['creden', 'tials'].join('');
const watchRoutes = [];
const hostTools = new Map();
const hostCommands = [];
// settings.mutate 收到的 ops：断言「用编辑器打开之后真的把 preferredEditor 写下去了」。
const mutateCalls = [];

function makeHostCtx() {
  return {
    get(name) {
      if (name === CRED) {
        return {
          async resolve(key) { return store.has(key) ? { value: store.get(key), source: 'store' } : undefined; },
          async set(key, value) { store.set(key, value); },
          async unset(key) { store.delete(key); },
        };
      }
      if (name === 'settings') {
        return {
          documentPath: PATCH_FILE,
          describe() { return [{ ns: 'jira-work-overview', revision: 1, autoGenerate: false }]; },
          async mutate(ns, ops, revision) { mutateCalls.push({ ns, ops, revision }); },
        };
      }
      if (name === 'commands') {
        return { register(definition) { hostCommands.push(definition); return () => {}; } };
      }
      if (name === 'connection') {
        return { fetch: { register(route) { watchRoutes.push(route); return async () => {}; } } };
      }
      return undefined;
    },
    tools: { register(definition) { hostTools.set(definition.name, definition); } },
    on() { return () => {}; },
    effect(fn) { const off = fn(); return () => { if (typeof off === 'function') off(); }; },
  };
}

const host = await import(pathToFileURL(HOST_COPY).href);

const baseConfig = {
  baseUrl: 'https://example.atlassian.net',
  email: 'you@example.com',
  projectKey: 'APP',
  boardId: 42,
  maxResults: 50,
  timeoutMs: 30000,
  // 关掉轮询：这个测试只关心文案，不要让后台定时器搅进来。
  watchEnabled: false,
};

// 语言用环境变量钉住时，Config 里的 language 会被越过 —— 先清掉，逐项自己设。
delete process.env.DSH_JIRA_LANG;

host.apply(makeHostCtx(), host.Config({ ...baseConfig, language: 'zh' }));
const commandZh = hostCommands.find((row) => row.name === 'jira');
const myWork = hostTools.get('jira_my_work');
const transitionTool = hostTools.get('jira_transition');

check('host 注册了 3 个工具与 /jira 命令', hostTools.size === 3 && commandZh !== undefined,
  `tools=${[...hostTools.keys()].join(',')} commands=${hostCommands.length}`);

const render = async (args = { scope: 'open' }) => String(await myWork.execute(args, { signal: undefined }));
const runCommand = async (input) => {
  const outcome = await commandZh.handler({ rawInput: input, signal: undefined });
  return outcome?.text ?? '';
};

/* ---- 1. Config language: zh ---- */
const zhText = await render();
check('zh：插件文案是中文', zhText.includes('我的未完成 issue') || zhText.includes('未完成'),
  zhText.split('\n')[0]?.slice(0, 40));
check('zh：Jira 摘要原样', zhText.includes(SUMMARY));
check('zh：Jira 状态名原样', zhText.includes(STATUS));
// 文本行只渲染「父需求 key」，父需求摘要与标签只有 --json 里才有 → 数据保真用 JSON 断言。
const zhJsonData = JSON.parse(await runCommand('--json --lang=zh'));
const zhItem = zhJsonData.items?.[0] ?? {};
check('zh：Jira 父需求 key 原样（JSON）', zhItem.parent === 'APP-1948', String(zhItem.parent));
check('zh：Jira 标签原样（JSON）', (zhItem.labels ?? []).includes('需求优化'), JSON.stringify(zhItem.labels));

/* ---- 2. Config language: en（同一份数据） ---- */
host.apply(makeHostCtx(), host.Config({ ...baseConfig, language: 'en' }));
const enText = String(await hostTools.get('jira_my_work').execute({ scope: 'open' }, { signal: undefined }));
check('en：插件文案换成英文', enText.includes('My open issues') && !enText.includes('我的未完成'), enText.split('\n')[0]?.slice(0, 60));
check('en：Jira 摘要仍逐字保留', enText.includes(SUMMARY));
check('en：Jira 状态名仍逐字保留', enText.includes(STATUS));
check('zh 与 en 的输出确实不同', zhText !== enText);

/* ---- 3. 操作覆盖 --lang= ---- */
const enOverride = await runCommand('open --lang=en');
check('--lang=en 覆盖 Config', enOverride.includes('My open issues'), enOverride.split('\n')[0]?.slice(0, 50));
const zhOverride = await runCommand('open --lang=zh');
check('--lang=zh 覆盖 Config=zh 时输出中文', zhOverride.includes(SUMMARY) && CJK.test(zhOverride),
  zhOverride.split('\n')[0]?.slice(0, 40));
check('--lang 不会跑到 JQL 里（输出里没有 lang 字样残留）', !/--lang/.test(zhOverride));
const zhJson = await runCommand('--json --lang=zh');
check('--json + --lang 组合可用', zhJson.includes(SUMMARY));

// 面板右侧的「共 N 项」来自 approximate-count（准确总数，不是页内条数）。
check('载荷里有准确总数 total', zhJsonData.total === 9, String(zhJsonData.total));
check('载荷里有每个项目的准确总数 projectTotals', JSON.stringify(zhJsonData.projectTotals) === '{"APP":9}', JSON.stringify(zhJsonData.projectTotals));
/* ---- 3b. 状态筛选 --status=：不改 Jira 数据保真，载荷里带 status / statusOptions ---- */
const statusJson = JSON.parse(await runCommand(`--json --lang=zh --status=${STATUS}`));
check('--status= 时 Jira 摘要仍逐字保留', statusJson.items?.[0]?.summary === SUMMARY, String(statusJson.items?.[0]?.summary));
check('--status= 时 Jira 状态名原样（没有被筛选值改写）', statusJson.items?.[0]?.status === STATUS, String(statusJson.items?.[0]?.status));
check('载荷里带了当前筛选 status', statusJson.status === STATUS, String(statusJson.status));
check('载荷里带了 statusOptions（状态名 + statusCategory 分类）', (() => {
  const row = (statusJson.statusOptions ?? []).find((entry) => entry.name === STATUS);
  return row?.category === 'indeterminate';
})(), JSON.stringify(statusJson.statusOptions));
const noStatusJson = JSON.parse(await runCommand('--json --lang=zh'));
check('不带 --status 时 status 为空串（全部）', noStatusJson.status === '', JSON.stringify(noStatusJson.status));
check('statusOptions 见过就记住（模块级缓存 + 本次 items）', (noStatusJson.statusOptions ?? []).some((entry) => entry.name === STATUS),
  JSON.stringify((noStatusJson.statusOptions ?? []).map((entry) => entry.name)));
const badStatus = JSON.parse(await runCommand(`--json --lang=zh --status=${String.fromCharCode(1)}bad`));
check('非法 --status（控制字符）被忽略、查询照常成功', badStatus.ok === true && badStatus.status === '', JSON.stringify(badStatus.status));
const spaceStatus = JSON.parse(await runCommand('--json --lang=zh --status=IN QA'));
check('--status= 支持带空格的状态名（IN QA 不被截断）', spaceStatus.status === 'IN QA', JSON.stringify(spaceStatus.status));
const enStatusText = await runCommand(`all --lang=en --status=${STATUS}`);
check('en：--status= 出现在英文命令里也不报错、数据原样', enStatusText.includes(SUMMARY), enStatusText.split('\n')[0]?.slice(0, 50));

const zhTag = await runCommand('open --lang=zh-CN');
check('--lang 接受完整 tag（zh-CN → 中文）', zhTag.includes('未完成') || CJK.test(zhTag));

/* ---- 3c. 条数：--limit=0 = 不限制（一直翻页到 isLast）；撞到安全上限要如实说「还有更多」 ---- */
paging.mode = 'many';
paging.pages = 0;
const manyJson = JSON.parse(await runCommand('--json --lang=zh --limit=0'));
check('--limit=0 一直翻到 isLast（3 页 × 100 条全拿到，不 slice 截断）',
  manyJson.items?.length === 300 && manyJson.hasMore === false, `items=${manyJson.items?.length} hasMore=${manyJson.hasMore}`);
check('--limit=0 时载荷里的 limit 就是 0（= 不限制，面板据此写「全部」）', manyJson.limit === 0, JSON.stringify(manyJson.limit));

paging.mode = 'infinite';
paging.pages = 0;
const cappedJson = JSON.parse(await runCommand('--json --lang=zh --limit=0'));
check('永远有下一页时停在 50 页安全上限（50 × 100 = 5000 条）',
  cappedJson.items?.length === 5000 && paging.pages === 50, `items=${cappedJson.items?.length} pages=${paging.pages}`);
check('撞到安全上限时如实回 hasMore: true（不假装取完了）', cappedJson.hasMore === true, String(cappedJson.hasMore));

paging.mode = 'many';
paging.pages = 0;
const limitedJson = JSON.parse(await runCommand('--json --lang=zh --limit=150'));
check('正数 --limit 仍然是上限（150 → 恰好 150 条，后面还有）',
  limitedJson.items?.length === 150 && limitedJson.hasMore === true && limitedJson.limit === 150,
  `items=${limitedJson.items?.length} hasMore=${limitedJson.hasMore} limit=${limitedJson.limit}`);

// 文本输出：取满安全上限时「还有更多」那行必须在，而且写的是真实安全上限 5000。
paging.mode = 'infinite';
paging.pages = 0;
const cappedText = await runCommand('all --limit=0 --lang=zh');
check('工具/命令文本输出保留「还有更多」并写真实安全上限 5000',
  cappedText.includes('还有更多') && cappedText.includes('5000'),
  cappedText.split('\n').find((line) => line.includes('还有更多'))?.slice(0, 120) ?? '（没有那一行）');
paging.mode = 'natural';
paging.pages = 0;

/* ---- 3d. timeoutMs 也是安全上限：整轮翻页共用一个总预算，到点收手但仍如实说「还有更多」 ---- */
host.apply(makeHostCtx(), host.Config({ ...baseConfig, timeoutMs: 1000, language: 'zh' }));
const slowCommand = hostCommands.filter((row) => row.name === 'jira').at(-1);
paging.mode = 'slow';
paging.pages = 0;
const slowStarted = Date.now();
const slowOutcome = await slowCommand.handler({ rawInput: '--json --lang=zh --limit=0', signal: undefined });
const slowJson = JSON.parse(slowOutcome?.text ?? '{}');
check('timeoutMs 到点（第 2 页卡住 > 1s）：拿到第 1 页就收手，不假装取完',
  slowJson.items?.length === 100 && slowJson.hasMore === true,
  `items=${slowJson.items?.length} hasMore=${slowJson.hasMore} 用时=${Date.now() - slowStarted}ms`);
paging.mode = 'natural';
paging.pages = 0;
host.apply(makeHostCtx(), host.Config({ ...baseConfig, language: 'zh' }));

/* ---- 4. DSH_JIRA_LANG 最高优先（测试/手动强制） ---- */
process.env.DSH_JIRA_LANG = 'zh';
const forcedZh = await runCommand('open --lang=en');
check('DSH_JIRA_LANG=zh 压过 --lang=en（测试强制最高优先）', CJK.test(forcedZh) && forcedZh.includes(SUMMARY));
process.env.DSH_JIRA_LANG = 'en';
const forcedEn = await runCommand('open --lang=zh');
check('DSH_JIRA_LANG=en 压过 --lang=zh', forcedEn.includes('My open issues') && forcedEn.includes(SUMMARY), forcedEn.split('\n')[0]?.slice(0, 40));
delete process.env.DSH_JIRA_LANG;

/* ---- 5. 工具：单条详情 / 流转预览 ---- */
host.apply(makeHostCtx(), host.Config({ ...baseConfig, language: 'en' }));
const issueEn = String(await hostTools.get('jira_issue').execute({ key: 'APP-4051' }, { signal: undefined }));
check('en：单条详情文案英文、摘要原样', issueEn.includes('## Description') && issueEn.includes(SUMMARY), issueEn.split('\n')[0]?.slice(0, 40));
host.apply(makeHostCtx(), host.Config({ ...baseConfig, language: 'zh' }));
const previewZh = String(await hostTools.get('jira_transition').execute({ key: 'APP-4051' }, { signal: undefined }));
check('zh：流转预览中文、目标状态名原样', CJK.test(previewZh) && previewZh.includes('IN QA'));
check('transitionTool 已注册', transitionTool !== undefined);

/* ---- 6. 路由 ?lang= ---- */
// 每次 host.apply 都会注册一套新路由，所以取「最后一次注册」的那条——否则会用上早期 apply
// 留下的旧闭包（比如没有 onOpenPatch 钩子的那次），断言就会指着旧行为。
const routeOf = (path) => [...watchRoutes].reverse().find((row) => row.path === path);
const callRoute = async (path, query, init) => {
  const route = routeOf(path);
  if (!route) return { status: 0, body: null };
  const request = new Request(`http://dsh.invalid${path}${query}`, init);
  const response = await route.fetch(request);
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
};

const TRANSITION_PATH = '/api/jira-work-overview/transition';
const badEn = await callRoute(TRANSITION_PATH, '?key=oops&lang=en');
const badZh = await callRoute(TRANSITION_PATH, '?key=oops&lang=zh');
check('路由 ?lang=en 返回英文错误', badEn.status === 400 && !CJK.test(String(badEn.body?.error ?? '')), String(badEn.body?.error ?? '').slice(0, 60));
check('路由 ?lang=zh 返回中文错误', badZh.status === 400 && CJK.test(String(badZh.body?.error ?? '')), String(badZh.body?.error ?? '').slice(0, 40));
check('两种语言的错误文案确实不同', JSON.stringify(badEn.body) !== JSON.stringify(badZh.body));

const SETTINGS_PATH = '/api/jira-work-overview/settings';
const settingsGet = await callRoute(SETTINGS_PATH, '?lang=zh');
check('设置路由可用（面板的配置弹窗靠它）', settingsGet.status === 200 && settingsGet.body?.ok === true);
check('设置路由带上了 patch 信息', settingsGet.body?.patch !== undefined,
  JSON.stringify(settingsGet.body?.patch ?? null).slice(0, 80));

/* ---- 6b. 打开 cordis.patch.yml（用 onOpenPatch 钩子，不真开文件） ---- */
const opened = [];
// 编辑器探测也走测试钩子：假装本机装了这两个，断言面板拿到的就是它们。
const fakeEditors = () => [
  { id: 'vscode', label: 'VS Code', launch: { kind: 'app', value: 'Visual Studio Code' } },
  { id: 'textedit', label: 'TextEdit', launch: { kind: 'app', value: 'TextEdit' } },
];
// 注意：必须传「裸配置对象」而不是 host.Config(...)——Config 的 schema 没声明 onOpenPatch /
// onDetectEditors，校验输出会把这些测试钩子丢掉（onNotify 同理）。
host.apply(makeHostCtx(), {
  ...baseConfig,
  language: 'zh',
  onOpenPatch: (mode, target, app) => { opened.push([mode, target, app]); },
  onDetectEditors: fakeEditors,
});

const patchGet = await callRoute(SETTINGS_PATH, '?lang=zh');
check('settings GET 带上了探测到的编辑器（只有 id / label）', (() => {
  const expected = JSON.stringify([{ id: 'vscode', label: 'VS Code' }, { id: 'textedit', label: 'TextEdit' }]);
  return JSON.stringify(patchGet.body?.patch?.editors) === expected;
})(), JSON.stringify(patchGet.body?.patch?.editors ?? null));
check('settings GET 的 preferredEditor 初值是空串', patchGet.body?.patch?.preferredEditor === '',
  JSON.stringify(patchGet.body?.patch?.preferredEditor ?? null));

const postOpen = (mode, app) => callRoute(SETTINGS_PATH, '?lang=zh', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(app === undefined ? { open: mode } : { open: mode, app }),
});
for (const mode of ['default', 'choose', 'reveal']) {
  const res = await postOpen(mode);
  check(`打开配置文件 ${mode}`, res.status === 200 && res.body?.ok === true && res.body?.mode === mode,
    JSON.stringify(res.body ?? null).slice(0, 70));
}
check('三种打开方式都真的调到系统层（onOpenPatch 钩子）', opened.map((row) => row[0]).join(',') === 'default,choose,reveal',
  JSON.stringify(opened.map((row) => row[0])));
check('打开的目标就是 profile 的 cordis.patch.yml', opened.every((row) => String(row[1]).endsWith('cordis.patch.yml')),
  String(opened[0]?.[1] ?? ''));
const badMode = await postOpen('bogus');
check('非法打开方式 → 400', badMode.status === 400 && badMode.body?.ok === false, String(badMode.body?.error ?? '').slice(0, 50));

/* ---- 6c. 编辑器直选 / 自由输入 ---- */
const appOpen = await postOpen('app', 'vscode');
check('用编辑器 vscode 打开 → 200 且回 app', appOpen.status === 200 && appOpen.body?.ok === true
  && appOpen.body?.mode === 'app' && appOpen.body?.app === 'vscode', JSON.stringify(appOpen.body ?? null).slice(0, 90));
check('app 模式把编辑器 id 当 onOpenPatch 第三参', opened.at(-1)?.[2] === 'vscode', JSON.stringify(opened.at(-1) ?? null));
check('app 模式顺带把 preferredEditor 写进配置 ops', mutateCalls.some((row) => (row.ops ?? []).some((op) => op.path?.[0] === 'preferredEditor' && op.value === 'vscode')),
  JSON.stringify(mutateCalls.at(-1)?.ops ?? null));

const appBad = await postOpen('app', 'nope');
check('未探测到的编辑器 id → 400 未知的编辑器', appBad.status === 400 && String(appBad.body?.error ?? '').includes('未知的编辑器'),
  String(appBad.body?.error ?? '').slice(0, 50));

const customEmpty = await postOpen('custom', '');
check('custom 空输入 → 400', customEmpty.status === 400 && customEmpty.body?.ok === false,
  String(customEmpty.body?.error ?? '').slice(0, 40));

const customOpen = await postOpen('custom', 'My Editor');
check('custom 打开 → 200 且回 app', customOpen.status === 200 && customOpen.body?.ok === true
  && customOpen.body?.mode === 'custom' && customOpen.body?.app === 'My Editor', JSON.stringify(customOpen.body ?? null).slice(0, 90));
check('custom 把应用名当 onOpenPatch 第三参', opened.at(-1)?.[2] === 'My Editor', JSON.stringify(opened.at(-1) ?? null));
check('custom 不写 preferredEditor（只在 app 模式记）', !mutateCalls.some((row) => (row.ops ?? []).some((op) => op.path?.[0] === 'preferredEditor' && op.value === 'My Editor')));

const customNewline = await postOpen('custom', 'My\nEditor');
check('custom 带换行 / 控制字符 → 400', customNewline.status === 400 && customNewline.body?.ok === false,
  String(customNewline.body?.error ?? '').slice(0, 40));

const watchWrite = await callRoute(SETTINGS_PATH, '?lang=zh', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ watchIntervalMs: 30000, language: 'en' }),
});
check('不带 open 的 POST 仍走写配置（老字段没坏）', watchWrite.status === 200 && watchWrite.body?.saved === true,
  JSON.stringify(watchWrite.body?.applied ?? null));
check('language 也进了写配置的 ops', watchWrite.body?.applied?.language === 'en', String(watchWrite.body?.applied?.language));

/* ---- 7. 默认语言（没有 DSH 偏好、环境是 C.UTF-8）不应崩 ---- */
delete process.env.LANG;
delete process.env.LC_ALL;
host.apply(makeHostCtx(), host.Config({ ...baseConfig, language: 'auto' }));
const autoText = String(await hostTools.get('jira_my_work').execute({ scope: 'open' }, { signal: undefined }));
check('language=auto 能正常出结果（不抛错、不是空）', autoText.includes(SUMMARY));

/* ---------------------------------------------------- client 半边 */

let factory;
// client 的请求全部转给「最后一次注册」的 host 路由：这样面板拿到的 patch.editors /
// preferredEditor 与 host 侧断言出自同一套探测结果，不是另写一份假数据。
const clientPosts = [];
const WATCH_PATH = '/api/jira-work-overview/state';
async function clientTransport(url, init) {
  const target = String(url);
  const path = target.split('?')[0];
  const body = init?.body ? JSON.parse(String(init.body)) : null;
  clientPosts.push({ path, method: String(init?.method ?? 'GET').toUpperCase(), body });
  // 角标长轮询：回 404 让客户端的 watch 循环自己停掉（它把 404 当「通道不存在」）。
  if (path === WATCH_PATH) return { ok: false, status: 404, async json() { return {}; } };
  const route = routeOf(path);
  if (!route) return { ok: false, status: 404, async json() { return {}; } };
  return route.fetch(new Request(`http://dsh.invalid${target}`, init ?? {}));
}
const windowStub = {
  __ModuleLoader__: { load(definition) { factory = definition.factory; } },
  __DSH_TRANSPORT__: { fetch: clientTransport },
};
globalThis.window = windowStub;
globalThis.document = {
  createElement: () => ({ setAttribute() {}, appendChild() {}, style: {}, dataset: {}, remove() {} }),
  head: { appendChild() {} },
  querySelector: () => null,
  addEventListener() {},
  removeEventListener() {},
};
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { language: 'zh-CN', languages: ['zh-CN', 'en'] } });
await import(pathToFileURL(join(WS, 'client.js')).href);

/* ------------------------------------------------------ 迷你 React（给下面的渲染断言用） */

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

const clientPlugin = factory((name) => {
  if (name === 'react') return React;
  if (name === 'react-dom') return { createPortal: (node) => node };
  if (name === '@tanstack/react-virtual') return { useVirtualizer: useVirtualizerStub };
  throw new Error(`unexpected require: ${name}`);
});

const localeCalls = [];
const localeSubs = [];
const slotRegistrations = [];
let localeSnapshot = { active: 'en', locales: [{ id: 'zh' }, { id: 'en' }] };
const clientCtx = {
  get(name) {
    if (name === 'locale') {
      return {
        register(ns, dict) { localeCalls.push({ kind: 'register', ns, dict }); return () => {}; },
        bind(ns) { localeCalls.push({ kind: 'bind', ns }); return (key) => (key === 'title' ? 'TITLE' : undefined); },
        getSnapshot() { return localeSnapshot; },
      };
    }
    return undefined;
  },
  on(event, handler) { if (event === 'locale/change') localeSubs.push(handler); return () => {}; },
  effect(fn) { const off = fn(); return () => { if (typeof off === 'function') off(); }; },
  slots: {
    inject(_name, build) { build(); },
    register(options, component) { slotRegistrations.push({ options, component }); return () => {}; },
  },
};

clientPlugin.apply(clientCtx);
const registered = localeCalls.find((row) => row.kind === 'register');
check('client 把字典注册进了 ctx.locale', registered?.ns === 'jira-work-overview'
  && typeof registered.dict?.zh?.title === 'string' && typeof registered.dict?.en?.title === 'string',
  registered ? `ns=${registered.ns} zh/en keys=${Object.keys(registered.dict.zh).length}/${Object.keys(registered.dict.en).length}` : 'no register');
check('client 绑定了自己的 ns', localeCalls.some((row) => row.kind === 'bind' && row.ns === 'jira-work-overview'));
check('client 订阅了 locale/change（切语言要重渲染）', localeSubs.length === 1);
localeSnapshot = { active: 'zh', locales: [{ id: 'zh' }, { id: 'en' }] };
let threw = false;
try {
  localeSubs[0]?.({ active: 'zh' });
  localeSubs[0]?.('en');
} catch (error) {
  threw = true;
  console.log('  locale/change 处理抛错:', error?.message);
}
check('locale/change 处理不抛错（字符串与快照两种形状都吃）', threw === false);
check('client 字典 zh/en 键完全对齐', (() => {
  const zh = Object.keys(registered?.dict?.zh ?? {}).sort();
  const en = Object.keys(registered?.dict?.en ?? {}).sort();
  return zh.length > 100 && zh.length === en.length && zh.every((key, index) => key === en[index]);
})(), `zh=${Object.keys(registered?.dict?.zh ?? {}).length} en=${Object.keys(registered?.dict?.en ?? {}).length}`);
// 0.12.0：渐进式渲染整套删掉（rendering 键必须消失），换成虚拟列表的条数口径文案。
check('进度小字键 rendering 已删（渐进式渲染整套退场）',
  registered?.dict?.zh?.rendering === undefined && registered?.dict?.en?.rendering === undefined,
  JSON.stringify(registered?.dict?.zh?.rendering ?? null));
check('「已加载 N 条（全部）」与安全上限措辞两语言都有',
  ['loadedAll', 'loadedCapped', 'loadedOf', 'loadMoreCap'].every((key) => typeof registered?.dict?.zh?.[key] === 'string' && typeof registered?.dict?.en?.[key] === 'string'),
  ['loadedAll', 'loadedCapped'].map((key) => `${key}:${registered?.dict?.zh?.[key] ?? '缺失'}`).join(' | '));
check('条数说明写的是「0 = 不限制」',
  String(registered?.dict?.zh?.resultsHint ?? '').includes('0 = 不限制') && String(registered?.dict?.en?.resultsHint ?? '').includes('unlimited'),
  String(registered?.dict?.zh?.resultsHint ?? '').slice(0, 40));

/* ---- 8. 「配置文件」组：编辑器直选 + 自由输入（真组件 + 真 host 路由） ---- */

// 上一段最后把语言切成了 en；这一段的文案断言都按中文写，先切回 zh。
localeSubs[0]?.({ active: 'zh' });

// 面板渲染时用的是「最后一次注册」的路由，所以这里再 apply 一次带钩子的配置。
host.apply(makeHostCtx(), {
  ...baseConfig,
  language: 'zh',
  onOpenPatch: (mode, target, app) => { opened.push([mode, target, app]); },
  onDetectEditors: fakeEditors,
});

const patchComponent = slotRegistrations.find((row) => row.options.name === 'plugins.bundle.config')?.component;
const renderPatch = (view) => {
  currentComponent = 'CredentialSettings';
  hookIndex = 0;
  return expand(createElement(patchComponent, { view }));
};
const byId = (tree, id) => collect(tree, (row) => row.props?.id === id)[0];
const buttonWith = (tree, label) => collect(tree, (row) => row.type === 'button' && text(row).trim() === label)[0];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let page = renderPatch('page');
await wait(80);
page = renderPatch('page');

const EDITOR_LABELS = ['VS Code', 'TextEdit'];
const editorButtons = () => collect(page, (row) => row.type === 'button'
  && ['VS Code', 'TextEdit', 'VS Code（上次用过）', 'TextEdit（上次用过）'].includes(text(row).trim()));
check('面板画出了探测到的编辑器按钮（数量与 label 都对）',
  editorButtons().length === 2 && editorButtons().map((row) => text(row).trim()).join(' / ') === EDITOR_LABELS.join(' / '),
  editorButtons().map((row) => text(row).trim()).join(' / '));

const customInput = () => byId(page, 'jmw-cred-custom-app');
check('自由输入框存在（占位符提示应用名或路径）', customInput() !== undefined
  && String(customInput().props.placeholder ?? '').includes('Code.exe'), String(customInput()?.props?.placeholder ?? ''));
const customButton = () => buttonWith(page, '打开');
check('空输入时「打开」按钮是禁用的', customButton()?.props?.disabled === true, String(customButton()?.props?.disabled));

// 点「VS Code」→ 应该发 {open:'app', app:'vscode'}，并且这个按钮被标成「上次用过」。
buttonWith(page, 'VS Code').props.onClick();
await wait(60);
page = renderPatch('page');
check('点编辑器按钮发出 {open:"app", app:"vscode"}', clientPosts.some((row) => row.method === 'POST'
  && row.body?.open === 'app' && row.body?.app === 'vscode'), JSON.stringify(clientPosts.at(-1)?.body ?? null));
check('用过的那个编辑器被标成「上次用过」', editorButtons().some((row) => text(row).trim() === 'VS Code（上次用过）'),
  editorButtons().map((row) => text(row).trim()).join(' / '));
check('编辑器打开的成功文案带应用名', text(page).includes('已交给 VS Code 打开'), text(page).includes('已交给') ? '文案里有「已交给」' : '文案里没有「已交给」');

// 自由输入：填好之后按钮可点 → 发 {open:'custom', app:'My Editor'}，成功后输入框清空。
customInput().props.onInput({ target: { value: 'My Editor' } });
page = renderPatch('page');
check('填了应用名之后「打开」按钮可点', customButton()?.props?.disabled === false, String(customButton()?.props?.disabled));
customButton().props.onClick();
await wait(60);
page = renderPatch('page');
check('自由输入发出 {open:"custom", app:"My Editor"}', clientPosts.some((row) => row.method === 'POST'
  && row.body?.open === 'custom' && row.body?.app === 'My Editor'), JSON.stringify(clientPosts.at(-1)?.body ?? null));
check('成功后输入框被清空', String(customInput()?.props?.value ?? '') === '', JSON.stringify(customInput()?.props?.value ?? null));
check('自由输入的成功文案带应用名', text(page).includes('已交给 My Editor 打开'));

/* ---------------------------------------------------- 收尾 */

const failed = results.filter((row) => row !== true).length;
console.log(`\n=== i18n 测试：${results.length - failed}/${results.length} 通过 ===`);
process.exit(failed === 0 ? 0 : 1);
