import { prepareHostCopy, skipWhenUnavailable } from './lib-host-runtime.mjs';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/* --- 跨平台：临时目录与本机凭据文件（Windows 上用 os.tmpdir()，可用 DSH_JIRA_TMP 覆盖） --- */
const TMP = process.env.DSH_JIRA_TMP || (existsSync(join('/tmp', '.dsh_jira_env')) ? '/tmp' : tmpdir());
const HOST_COPY = join(TMP, 'dsh-jira-smoke3', 'index.js');
const prep = prepareHostCopy({ ws: dirname(dirname(fileURLToPath(import.meta.url))), dest: HOST_COPY });
skipWhenUnavailable(prep);
const ENV_FILE = process.env.DSH_JIRA_ENV_FILE || join(TMP, '.dsh_jira_env');
/* 没有非交互式环境文件（典型是 Linux / Windows 没建过）时开一个空文件，凭据由 JIRA_API_TOKEN / JIRA_BASE_URL / JIRA_EMAIL 环境变量提供，套件照常 SKIP 而不是崩。 */
mkdirSync(TMP, { recursive: true }); // TMP 目录本身也可能还不存在（干净机器 / CI）
if (!existsSync(ENV_FILE)) writeFileSync(ENV_FILE, '', { mode: 0o600 });
mkdirSync(join(TMP, 'dsh-jira-smoke3'), { recursive: true });

const envText = fs.readFileSync(ENV_FILE, 'utf8');
const readEnv = (key) => {
  const m = envText.match(new RegExp(`^${key}=(.*)$`, 'm'));
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : undefined;
};

/* 项目键不写死在仓库里：优先 DSH_JIRA_PROJECT / env 文件里的 JIRA_PROJECT，默认假值 APP。 */
const PROJECT = process.env.DSH_JIRA_PROJECT || readEnv('JIRA_PROJECT') || 'APP';
const BOARD = Number(process.env.DSH_JIRA_BOARD || readEnv('JIRA_BOARD') || 42);

const mod = await import(pathToFileURL(HOST_COPY).href);

const captured = [];
const ctx = {
  get: () => undefined,
  tools: {
    register(definition) {
      captured.push(definition);
      return () => {};
    },
  },
};

mod.apply(ctx, {
  baseUrl: 'https://example.atlassian.net',
  email: readEnv('JIRA_EMAIL'),
  apiToken: readEnv('JIRA_API_TOKEN'),
  projectKey: PROJECT,
  boardId: BOARD,
  maxResults: 50,
  timeoutMs: 30000,
});

console.log('exports:', typeof mod.apply, 'inject =', JSON.stringify(mod.inject));
console.log('tools:', captured.map((t) => t.name).join(', '));

for (const def of captured) {
  const shape =
    typeof def.name === 'string' &&
    typeof def.description === 'string' &&
    def.parameters?.type === 'object' &&
    typeof def.output?.schema === 'object' &&
    typeof def.output?.render === 'function' &&
    typeof def.execute === 'function' &&
    Number.isFinite(def.timeoutMs);
  const rendered = def.output.render({}, 'probe');
  const renderOk = Array.isArray(rendered) && rendered[0]?.type === 'text' && rendered[0]?.text === 'probe';
  console.log(`shape ${def.name}: ${shape ? 'OK' : 'BAD'}  render: ${renderOk ? 'OK' : 'BAD'}`);
}

const work = captured.find((t) => t.name === 'jira_my_work');
const issue = captured.find((t) => t.name === 'jira_issue');

try {
  console.log('\n===== jira_my_work scope=open limit=10 =====');
  console.log(await work.execute({ scope: 'open', limit: 10 }, {}));
} catch (error) {
  // 探针：站点不可达 / 临时 5xx 时 SKIP（离线 shape / render 检查已经跑完了）。
  console.log(`\nSKIP: Jira 不可用（${error?.message ?? error}）`);
  process.exit(0);
}

console.log('\n===== jira_my_work scope=sprint limit=10 =====');
console.log(await work.execute({ scope: 'sprint', limit: 10 }, {}));

console.log(`\n===== jira_issue ${PROJECT}-3489 (comments) =====`);
console.log(await issue.execute({ key: `${PROJECT}-3489`, comments: true, comment_limit: 3 }, {}));

console.log('\n===== bad key handling =====');
try {
  await issue.execute({ key: 'oops' }, {});
  console.log('BAD: no error thrown');
} catch (error) {
  console.log('OK:', error.message);
}
