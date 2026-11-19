/**
 * Jira 搜索（面板搜索框 / `/jira --search=`）的离线端到端测试。
 *
 * 覆盖：关键词 → `text ~ "…"` 全文搜索（整站，不带 assignee）、issue key / 浏览链接 → `key = "…"`、
 * 引号与反斜杠转义、多词搜索词不丢词、与 `--status=` 组合时 AND 插在 ORDER BY 之前、
 * 空搜索回退原范围、JSON 载荷带 query.search、结果按 sprint 分组（迭代名 / 组头顺序 / 条目归属）。
 *
 * 用法：ELECTRON_RUN_AS_NODE=1 "$BIN" test/dsh-jira-search.mjs
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TMP = process.env.DSH_JIRA_TMP || (existsSync(join('/tmp', '.dsh_jira_env')) ? '/tmp' : tmpdir());
// 和其它离线套件共用这个目录：里面放着一份 @deepseek-ai/schemastery（只在 DSH 应用里能解析）。
const DIR = join(TMP, 'dsh-jira-smoke3');
// 项目目录名里带空格（`dsh plugins`），必须走 fileURLToPath：URL.pathname 会把空格转成 %20。
const WS = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
mkdirSync(DIR, { recursive: true });
const HOST_COPY = join(DIR, 'index.js');
copyFileSync(join(WS, 'index.js'), HOST_COPY);

const results = [];
const check = (label, value, extra = '') => {
  results.push(value === true);
  console.log(`${value === true ? 'PASS' : 'FAIL'}  ${label}${extra ? ` | ${extra}` : ''}`);
};

/* --------------------------------------------------------- 假 Jira 数据 */

const SPRINT_26 = { id: 811, name: 'APP Sprint 26', state: 'active', startDate: '2026-10-09T16:00:39.000Z', endDate: '2026-10-25T15:30:00.000Z' };
const SPRINT_25 = { id: 805, name: 'APP Sprint 25', state: 'closed', startDate: '2026-09-18T16:00:00.000Z', endDate: '2026-10-04T15:30:00.000Z' };
const issues = [
  {
    key: 'APP-4051',
    fields: {
      summary: '網上APP入會，電郵地址默認值',
      status: { name: 'In Review', statusCategory: { key: 'indeterminate' } },
      issuetype: { name: 'Story' },
      priority: { id: '2', name: 'High' },
      labels: ['search'],
      updated: '2026-11-18T11:02:00.000+0800',
      customfield_10020: [SPRINT_26],
    },
  },
  {
    key: 'APP-4001',
    fields: {
      summary: '旧的会员页',
      status: { name: 'Done', statusCategory: { key: 'done' } },
      issuetype: { name: 'Task' },
      priority: { id: '3', name: 'Medium' },
      labels: [],
      updated: '2026-10-02T09:00:00.000+0800',
      customfield_10020: [SPRINT_25],
    },
  },
];

// 每个搜索请求的 jql 都记下来：断言「面板/命令发的 JQL」而不是只看返回。
const searchJqls = [];
const countJqls = [];
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
      return json([{ id: 'customfield_10020', name: 'Sprint', schema: { custom: 'com.pyxis.greenhopper.jira:gh-sprint' } }]);
    }
    if (target.includes('/rest/api/3/priority')) {
      return json([{ id: '1', name: 'Highest' }, { id: '2', name: 'High' }, { id: '3', name: 'Medium' }]);
    }
    if (target.includes('/rest/api/3/search/jql')) {
      const jql = new URL(target).searchParams.get('jql') ?? '';
      searchJqls.push(jql);
      // issue key 直达只回那一条；全文搜索回两条（两个 sprint）。
      const key = /^key\s*=\s*"([^"]+)"$/.exec(jql.trim())?.[1];
      const rows = key ? issues.filter((issue) => issue.key === key) : issues;
      return json({ issues: rows, isLast: true });
    }
    if (target.includes('/rest/api/3/search/approximate-count')) {
      const body = JSON.parse(String(init?.body ?? '{}'));
      countJqls.push(String(body.jql ?? ''));
      return json({ count: 2 });
    }
    if (target.includes('/rest/agile/1.0/board/')) {
      return json({ values: [SPRINT_26] });
    }
    return json({});
  },
});

/* -------------------------------------------------------------- host */

const store = new Map([['JIRA_API_TOKEN', 'ATATT3xFfGF0TOKEN00000000000000000000000000000000001DB8F000']]);
const CRED = ['creden', 'tials'].join('');
const hostCommands = [];

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
        return { describe() { return []; }, async mutate() {} };
      }
      if (name === 'commands') {
        return { register(definition) { hostCommands.push(definition); return () => {}; } };
      }
      return undefined;
    },
    tools: { register() {} },
    on() { return () => {}; },
    effect(fn) { const off = fn(); return () => { if (typeof off === 'function') off(); }; },
  };
}

delete process.env.DSH_JIRA_LANG;
const host = await import(pathToFileURL(HOST_COPY).href);
host.apply(makeHostCtx(), host.Config({
  baseUrl: 'https://example.atlassian.net',
  email: 'you@example.com',
  projectKey: 'APP',
  boardId: 42,
  maxResults: 50,
  timeoutMs: 30000,
  watchEnabled: false,
  language: 'zh',
}));
const command = hostCommands.find((row) => row.name === 'jira');
check('/jira 命令已注册', command !== undefined, `commands=${hostCommands.length}`);

const runCommand = async (input) => {
  const outcome = await command.handler({ rawInput: input, signal: undefined });
  return String(outcome?.text ?? '');
};
const runJson = async (input) => {
  const text = await runCommand(`--json ${input}`);
  try { return JSON.parse(text); } catch (error) {
    console.log('  JSON 解析失败：', text.slice(0, 300));
    throw error;
  }
};

/* ------------------------------------------------------------- 断言 */

// 1. 普通关键词：整站全文搜索，不带 assignee，结果按 sprint 分组（id 从新到旧）。
let payload = await runJson('--search=網上APP');
check('关键词 → scope=search', payload.query?.scope === 'search', `scope=${payload.query?.scope}`);
check('关键词 → text ~ 全文搜索', payload.query?.jql === 'text ~ "網上APP" ORDER BY updated DESC', `jql=${payload.query?.jql}`);
check('搜索不带 assignee = currentUser()', !String(payload.query?.jql ?? '').includes('currentUser'));
check('请求真的带上了搜索 JQL', searchJqls.at(-1) === 'text ~ "網上APP" ORDER BY updated DESC', `request=${searchJqls.at(-1)}`);
check('载荷回显搜索词', payload.query?.search === '網上APP', `search=${payload.query?.search}`);
check('结果两条都在', Array.isArray(payload.items) && payload.items.length === 2, `items=${payload.items?.length}`);
check('按迭代分组：Sprint 26 在 Sprint 25 前',
  JSON.stringify(payload.sprints?.map((group) => group.name)) === JSON.stringify(['APP Sprint 26', 'APP Sprint 25']),
  `sprints=${payload.sprints?.map((group) => group.name)}`);
check('条目带所属迭代', payload.items?.find((item) => item.key === 'APP-4051')?.sprint === 'APP Sprint 26'
  && Number(payload.items?.find((item) => item.key === 'APP-4051')?.sprintId) === 811,
  `sprint=${payload.items?.[0]?.sprint}/${payload.items?.[0]?.sprintId}`);
check('组头计数正确', payload.sprints?.every((group) => group.counts?.total === group.keys?.length),
  JSON.stringify(payload.sprints?.map((group) => [group.name, group.counts?.total])));

// 2. issue key 直达（Jira 搜索框的行为）。
payload = await runJson('--search=APP-4051');
check('issue key → key = "…"', payload.query?.jql === 'key = "APP-4051"', `jql=${payload.query?.jql}`);
check('issue key → 只回那一条', payload.items?.length === 1 && payload.items[0]?.key === 'APP-4051', `items=${payload.items?.map((item) => item.key)}`);

// 3. 粘贴浏览链接也走 key 直达。
payload = await runJson('--search=https://example.atlassian.net/browse/APP-4001');
check('浏览链接 → key = "…"', payload.query?.jql === 'key = "APP-4001"', `jql=${payload.query?.jql}`);

// 4. 引号 / 反斜杠转义（不让用户输入把 JQL 弄坏）。
payload = await runJson('--search=foo"bar\\baz');
check('引号与反斜杠被转义',
  payload.query?.jql === 'text ~ "foo\\"bar\\\\baz" ORDER BY updated DESC',
  `jql=${JSON.stringify(payload.query?.jql)}`);

// 5. 多词搜索词：`--search=` 一路吃到下一个开关为止，一个词都不丢。
payload = await runJson('--search=網上 APP --status=In Review');
check('多词搜索词完整保留', payload.query?.search === '網上 APP', `search=${payload.query?.search}`);
check('状态筛选拼在 ORDER BY 之前',
  payload.query?.jql === 'text ~ "網上 APP" AND status = "In Review" ORDER BY updated DESC',
  `jql=${payload.query?.jql}`);
// count 还会多拼一个 project 条件（项目 tab 的总数），关键是 ORDER BY 仍在最后。
check('approximate-count 的 JQL 也没有把 ORDER BY 弄乱',
  countJqls.at(-1) === 'text ~ "網上 APP" AND status = "In Review" AND project = "APP" ORDER BY updated DESC',
  `count=${countJqls.at(-1)}`);

// 6. 空搜索回退到原来的范围（不会发 text ~ ""）；面板发的就是 `all … --search=`。
payload = await runJson('all --limit=0 --search=');
check('空搜索回退 scope=all', payload.query?.scope === 'all', `scope=${payload.query?.scope}`);
check('空搜索回退到「我的全部 issue」JQL',
  payload.query?.jql === 'assignee = currentUser() ORDER BY updated DESC', `jql=${payload.query?.jql}`);
check('空搜索不发 text ~ ""', !String(payload.query?.jql ?? '').includes('text ~ ""'), `jql=${payload.query?.jql}`);

// 7. 文本输出（不带 --json）也认搜索范围。
const text = await runCommand('--search=網上APP');
check('文本输出标出「Jira 搜索结果」', text.includes('Jira 搜索结果'), text.split('\n')[0]?.slice(0, 60));
check('文本输出带 Jira 摘要原文', text.includes('網上APP入會，電郵地址默認值'));

console.log(results.every(Boolean) ? '\n=== 搜索：全部通过 ===' : `\n=== 搜索：${results.filter((ok) => !ok).length} 项失败 ===`);
process.exit(results.every(Boolean) ? 0 : 1);
