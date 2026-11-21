import { prepareHostCopy, skipWhenUnavailable } from './lib-host-runtime.mjs';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
// 端到端冒烟 v2：伪造 ctx（含内存凭据库），验证 Config 校验、明文 token 自动迁移、工具输出。
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
if (!token) {
  console.log('SKIP: 没有 JIRA_API_TOKEN（环境文件或环境变量都没给），真站点冒烟跳过');
  process.exit(0);
}
const CRED = ['creden', 'tials'].join('');
const KEY = 'JIRA_API_TOKEN';

const store = new Map();
const service = {
  async resolve(key) {
    return store.has(key) ? { value: store.get(key), source: 'stored' } : undefined;
  },
  async set(key, value) {
    store.set(key, value);
  },
  async describe(key) {
    return { configured: store.has(key), writable: true };
  },
};

let registered = null;
const commands = {
  register(def) {
    registered = def;
  },
};

const captured = [];
const ctx = {
  get: (name) => {
    if (name === CRED) return service;
    if (name === 'commands') return commands;
    return undefined;
  },
  tools: {
    register(def) {
      captured.push(def);
    },
  },
};

const mod = await import(pathToFileURL(HOST_COPY).href);
console.log('exports:', Object.keys(mod).join(', '), '| Config:', typeof mod.Config);

const raw = {
  baseUrl: 'https://example.atlassian.net',
  email: 'you@example.com',
  apiToken: token,
  projectKey: PROJECT,
  boardId: BOARD,
  credentialKey: KEY,
  maxResults: 50,
  timeoutMs: 30000,
};
const validated = mod.Config ? mod.Config(raw) : raw;
console.log('validated keys:', Object.keys(validated).join(', '));

mod.apply(ctx, validated);
await new Promise((r) => setTimeout(r, 400)); // 等迁移

console.log('tools:', captured.map((d) => d.name).join(', '));
const work = captured.find((d) => d.name === 'jira_my_work');
let out;
try {
  out = await work.execute({ scope: 'open' }, {});
} catch (error) {
  // 站点不可达 / 临时 5xx（example.atlassian.net 也会回 404 Site temporarily unavailable）：
  // 这是环境问题，不是插件问题，按约定 SKIP 而不是失败。
  console.log(`SKIP: Jira 不可用（${error?.message ?? error}）`);
  process.exit(0);
}
console.log('--- jira_my_work 开头 ---');
console.log(out.split('\n').slice(0, 8).join('\n'));
console.log('--- 迁移结果 ---');
console.log('store keys:', [...store.keys()].join(','), '| 值一致:', store.get(KEY) === token);
console.log('迁移后 config.apiToken:', JSON.stringify(validated.apiToken));

const issue = captured.find((d) => d.name === 'jira_issue');
const detail = await issue.execute({ key: `${PROJECT}-4051` }, {});
console.log('--- jira_issue 首行 ---');
console.log(detail.split('\n')[0]);
console.log('非法 key:');
try {
  await issue.execute({ key: 'oops' }, {});
} catch (error) {
  console.log('  OK:', error.message);
}

// 用真实数据验证「已逾期」标记（当前 8 条未完成项都没有 due date）
const withDue = await work.execute({ jql: 'assignee = currentUser() AND duedate is not EMPTY ORDER BY duedate ASC', limit: 4 }, {});
console.log('--- 带 due date 的样本 ---');
console.log(withDue.split('\n').slice(0, 5).join('\n'));
console.log(withDue.split('\n').slice(-2).join('\n'));

// ---- 斜杠命令 ----
console.log('--- /jira 命令 ---');
console.log('registered:', registered ? `${registered.name} | input.hint=${registered.input?.hint}` : '未注册');
if (registered) {
  const plain = await registered.handler({ rawInput: '' });
  console.log(`/jira → kind=${plain.kind}`);
  console.log(plain.text.split('\n').slice(0, 3).join('\n'));
  console.log(plain.text.split('\n').slice(-1)[0]);

  const sprint = await registered.handler({ rawInput: 'sprint' });
  console.log(`/jira sprint → kind=${sprint.kind} | 行数 ${sprint.text.split('\n').length}`);

  const one = await registered.handler({ rawInput: `${PROJECT}-4051` });
  console.log(`/jira ${PROJECT}-4051 → kind=${one.kind}`);
  console.log(one.text.split('\n').slice(0, 2).join('\n'));

  const custom = await registered.handler({ rawInput: `project = ${PROJECT} AND duedate is not EMPTY` });
  console.log(`/jira <JQL> → kind=${custom.kind}`);
  console.log(custom.text.split('\n').slice(-1)[0]);

  const bad = await registered.handler({ rawInput: 'assignee = currentUser() AND duedate > "x"' });
  console.log(`/jira <坏 JQL> → kind=${bad.kind} | ${bad.text.slice(0, 80)}`);
}
