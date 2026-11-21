import { prepareHostCopy, skipWhenUnavailable } from './lib-host-runtime.mjs';
// host 侧：验证 /jira --json 的 sprint 分组数据（真实 Jira）。
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/* --- 跨平台：临时目录与本机凭据文件（Windows 上用 os.tmpdir()，可用 DSH_JIRA_TMP 覆盖） --- */
const TMP = process.env.DSH_JIRA_TMP || (existsSync(join('/tmp', '.dsh_jira_env')) ? '/tmp' : tmpdir());
const HOST_COPY = join(TMP, 'dsh-jira-smoke3', 'index.js');
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

const store = new Map();
const tools = new Map();
const commands = [];
const CRED = ['creden', 'tials'].join('');
const credentials = {
  async resolve(key) {
    return store.has(key) ? { value: store.get(key), source: 'store' } : undefined;
  },
  async set(key, value) {
    store.set(key, value);
  },
};
const ctx = {
  get(name) {
    if (name === CRED) return credentials;
    if (name === 'commands') {
      return {
        register(definition) {
          commands.push(definition);
          return () => {};
        },
      };
    }
    return undefined;
  },
  tools: {
    register(definition) {
      tools.set(definition.name, definition);
    },
  },
};

const mod = await import(pathToFileURL(HOST_COPY).href);
mod.apply(ctx, {
  baseUrl: env.JIRA_BASE_URL,
  email: env.JIRA_EMAIL,
  apiToken: env.JIRA_API_TOKEN,
  projectKey: PROJECT,
  boardId: BOARD,
  maxResults: 50,
  timeoutMs: 30000,
});

console.log('tools =', [...tools.keys()].join(', '), '| commands =', commands.map((row) => row.name).join(', '));
const command = commands.find((row) => row.name === 'jira');

for (const raw of ['--json', '--json all', '--json ' + PROJECT + '-4018']) {
  const out = await command.handler({ commandId: 'jira', rawInput: raw, attachments: [], signal: undefined });
  if (out.kind !== 'success') {
    console.log(`\n=== /jira ${raw} → ${out.kind}: ${out.text}`);
    continue;
  }
  const data = JSON.parse(out.text);
  if (data.item) {
    console.log(`\n=== /jira ${raw} → 单条 ${data.item.key}，sprint 字段 = ${JSON.stringify({ id: data.item.sprintId, name: data.item.sprint, state: data.item.sprintState })}`);
    continue;
  }
  console.log(`\n=== /jira ${raw} → 共 ${data.counts.total} 条，${data.sprints.length} 组（${data.query.scope}）===`);
  for (const group of data.sprints) {
    const open = group.counts.new + group.counts.indeterminate;
    console.log(
      `${group.active ? '★' : ' '} ${group.name} | ${group.state || '-'} | ${group.start || '-'} → ${group.end || '-'}`
      + ` | 共 ${group.counts.total}（未完成 ${open}） | ${group.keys.join(', ')}`,
    );
  }
}
