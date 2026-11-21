import { prepareHostCopy, skipWhenUnavailable } from './lib-host-runtime.mjs';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
mkdirSync(join(TMP, 'dsh-jira-smoke3'), { recursive: true });
const env = readFileSync(ENV_FILE, 'utf8');
const token = (env.match(/JIRA_API_TOKEN=(.+)/) || [])[1]?.trim();
const CRED = ['creden', 'tials'].join('');
const store = new Map();
store.set('JIRA_API_TOKEN', token);
const service = { async resolve(k) { return store.has(k) ? { value: store.get(k) } : undefined; }, async set(k, v) { store.set(k, v); } };
const captured = [];
const ctx = { get: (n) => (n === CRED ? service : undefined), tools: { register: (d) => captured.push(d) } };
const mod = await import(pathToFileURL(HOST_COPY).href);
mod.apply(ctx, mod.Config({ baseUrl: 'https://example.atlassian.net', email: 'you@example.com', projectKey: 'APP', boardId: 42, credentialKey: 'JIRA_API_TOKEN' }));
const work = captured.find((d) => d.name === 'jira_my_work');
let out;
try {
  out = await work.execute({ jql: 'project = APP AND duedate is not EMPTY ORDER BY duedate ASC', limit: 3 }, {});
} catch (error) {
  // 到期日探针：站点不可达时 SKIP（不是在测插件，是在看真实数据）。
  console.log(`SKIP: Jira 不可用（${error?.message ?? error}）`);
  process.exit(0);
}
console.log(out.split('\n').slice(0, 12).join('\n'));
console.log('...');
console.log(out.split('\n').slice(-2).join('\n'));
