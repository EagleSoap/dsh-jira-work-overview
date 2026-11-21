import { prepareHostCopy, skipWhenUnavailable } from './lib-host-runtime.mjs';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
// 结构化输出（--json）的端到端验证：直接 import 工作区里的插件，用真实 Jira 数据。
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/* --- 跨平台：临时目录与本机凭据文件（Windows 上用 os.tmpdir()，可用 DSH_JIRA_TMP 覆盖） --- */
const TMP = process.env.DSH_JIRA_TMP || (existsSync(join('/tmp', '.dsh_jira_env')) ? '/tmp' : tmpdir());
const HOST_COPY = join(TMP, 'dsh-jira-smoke3', 'index.js');
const prep = prepareHostCopy({ ws: dirname(dirname(fileURLToPath(import.meta.url))), dest: HOST_COPY });
skipWhenUnavailable(prep);
const ENV_FILE = process.env.DSH_JIRA_ENV_FILE || join(TMP, '.dsh_jira_env');
/* 没有非交互式环境文件（典型是 Linux / Windows 没建过）时开一个空文件，凭据由 JIRA_API_TOKEN / JIRA_BASE_URL / JIRA_EMAIL 环境变量提供，套件照常 SKIP 而不是崩。 */
if (!existsSync(ENV_FILE)) writeFileSync(ENV_FILE, '', { mode: 0o600 });

/* 项目键不写死在仓库里：优先 DSH_JIRA_PROJECT / env 文件里的 JIRA_PROJECT，默认假值 APP。 */
const PROJECT = process.env.DSH_JIRA_PROJECT
  || (readFileSync(ENV_FILE, 'utf8').match(/^JIRA_PROJECT=(.+)$/m) || [])[1]?.trim()
  || 'APP';
const BOARD = Number(process.env.DSH_JIRA_BOARD
  || (readFileSync(ENV_FILE, 'utf8').match(/^JIRA_BOARD=(.+)$/m) || [])[1]?.trim()
  || 42);
mkdirSync(join(TMP, 'dsh-jira-smoke3'), { recursive: true });

const env = readFileSync(ENV_FILE, 'utf8');
const token = (env.match(/JIRA_API_TOKEN=(.+)/) || [])[1]?.trim();
const CRED = ['creden', 'tials'].join('');

const store = new Map([['JIRA_API_TOKEN', token]]);
const service = {
  async resolve(key) { return store.has(key) ? { value: store.get(key), source: 'stored' } : undefined; },
  async set(key, value) { store.set(key, value); },
  async describe(key) { return { configured: store.has(key), writable: true }; },
};

let registered = null;
let toolCount = 0;
const ctx = {
  get: (name) => (name === CRED ? service : name === 'commands' ? { register: (d) => { registered = d; } } : undefined),
  tools: { register: () => { toolCount += 1; } },
};

const mod = await import(pathToFileURL(HOST_COPY).href);
mod.apply(ctx, mod.Config({
  baseUrl: 'https://example.atlassian.net',
  email: 'you@example.com',
  projectKey: PROJECT,
  boardId: BOARD,
  credentialKey: 'JIRA_API_TOKEN',
  maxResults: 50,
  timeoutMs: 30000,
}));
await new Promise((r) => setTimeout(r, 300));

console.log('tools registered:', toolCount, '| command:', registered ? `${registered.name} hint=${registered.input.hint}` : '无');

const list = await registered.handler({ rawInput: '--json' });
console.log(`\n/jira --json → kind=${list.kind}`);
const payload = JSON.parse(list.text);
// --json 失败时 host 回 ok:false + error.code（不再抛错）。这个探针要真站点数据，拿不到就 SKIP。
if (payload.ok === false) {
  console.log(`SKIP: /jira --json 失败（${payload.error?.code}）：${payload.error?.message ?? '-'}`);
  process.exit(0);
}
console.log('顶层字段:', Object.keys(payload).join(', '));
console.log('query:', JSON.stringify(payload.query));
console.log('credentialSource:', payload.credentialSource);
console.log('sprint:', JSON.stringify(payload.sprint));
console.log('counts:', JSON.stringify(payload.counts));
// 从属关系（epic 视图）：载荷里必须有 epics 数组、形状与 sprints 同构（keys + counts + projects），
// 且每条 item 都带 parentKey / epicKey（没挂就是空串，不能是 undefined——前端靠它判断要不要画关联行）。
console.log('epics:', JSON.stringify((payload.epics ?? []).map((group) => ({ key: group.key, name: group.name, projects: group.projects, total: group.counts?.total }))));
const epicsOk = Array.isArray(payload.epics)
  && payload.epics.every((group) => Array.isArray(group.keys) && Array.isArray(group.projects) && typeof group.counts?.total === 'number');
const relationFieldsOk = payload.items.every((item) => typeof item.parentKey === 'string' && typeof item.epicKey === 'string');
console.log(epicsOk ? 'PASS  epics 载荷形状与 sprints 同构' : 'FAIL  epics 载荷形状不对');
console.log(relationFieldsOk ? 'PASS  每条 item 都带 parentKey / epicKey 字符串' : 'FAIL  item 缺 parentKey / epicKey');
if (!epicsOk || !relationFieldsOk) process.exitCode = 1;
console.log('items:', payload.items.length);
for (const item of payload.items.slice(0, 3)) {
  console.log('  ·', item.key, '|', item.category, '|', item.status, '|', item.priority, '|', item.summary.slice(0, 28), '|', item.url);
}

const filtered = await registered.handler({ rawInput: '--json project = ' + PROJECT + ' AND duedate is not EMPTY' });
const due = JSON.parse(filtered.text);
console.log('\n/jira --json <JQL> → 总数', due.counts.total, '| 逾期', due.items.filter((i) => i.overdue).map((i) => i.key).join('、'));

const one = await registered.handler({ rawInput: '--json ' + PROJECT + '-4051' });
const detail = JSON.parse(one.text);
console.log('/jira --json ' + PROJECT + '-4051 →', detail.item.key, '|', detail.item.status, '| 描述长度', detail.item.description.length, '| 模块', JSON.stringify(detail.item.components));

const plain = await registered.handler({ rawInput: '' });
console.log('\n/jira（纯文本回归）→ kind=' + plain.kind + ' | 首行: ' + plain.text.split('\n')[0]);
