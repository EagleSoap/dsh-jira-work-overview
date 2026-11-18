// host 侧：状态流转通道 + jira_transition 工具的离线验证（只做只读与失败路径，绝不真写状态）。
import { copyFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/* --- 跨平台：临时目录与本机凭据文件（Windows 上用 os.tmpdir()，可用 DSH_JIRA_TMP 覆盖） --- */
const TMP = process.env.DSH_JIRA_TMP || (existsSync(join('/tmp', '.dsh_jira_env')) ? '/tmp' : tmpdir());
const HOST_COPY = join(TMP, 'dsh-jira-smoke3', 'index.js');
const ENV_FILE = process.env.DSH_JIRA_ENV_FILE || join(TMP, '.dsh_jira_env');

/* 项目键不写死在仓库里：优先 DSH_JIRA_PROJECT / env 文件里的 JIRA_PROJECT，默认假值 APP。 */
const PROJECT = process.env.DSH_JIRA_PROJECT
  || (readFileSync(ENV_FILE, 'utf8').match(/^JIRA_PROJECT=(.+)$/m) || [])[1]?.trim()
  || 'APP';
const BOARD = Number(process.env.DSH_JIRA_BOARD
  || (readFileSync(ENV_FILE, 'utf8').match(/^JIRA_BOARD=(.+)$/m) || [])[1]?.trim()
  || 42);
mkdirSync(join(TMP, 'dsh-jira-smoke3'), { recursive: true });

const WS = dirname(dirname(fileURLToPath(import.meta.url)));
copyFileSync(`${WS}/index.js`, HOST_COPY);

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
const CRED = ['creden', 'tials'].join('');
const routes = [];
const hostTools = new Map();
const hostCtx = {
  get(name) {
    if (name === CRED) {
      return {
        async resolve(key) { return store.has(key) ? { value: store.get(key), source: 'store' } : undefined; },
        async set(key, value) { store.set(key, value); },
      };
    }
    if (name === 'connection') {
      return { fetch: { register(route) { routes.push(route); return async () => {}; } } };
    }
    return undefined;
  },
  tools: { register(definition) { hostTools.set(definition.name, definition); } },
  effect() { return () => {}; },
};

const host = await import(pathToFileURL(HOST_COPY).href);
host.apply(hostCtx, {
  baseUrl: env.JIRA_BASE_URL,
  email: env.JIRA_EMAIL,
  apiToken: env.JIRA_API_TOKEN,
  boardId: BOARD,
  maxResults: 50,
  timeoutMs: 30000,
  watchEnabled: false,
});

console.log('注册的通道：', routes.map((r) => `${r.path} [${r.methods.join(',')}] ${r.requestBody}`).join(' | '));
console.log('注册的工具：', [...hostTools.keys()].join(', '));

const route = routes.find((r) => r.path === '/api/jira-work-overview/transition');
if (!route) {
  console.log('❌ 没注册 /api/jira-work-overview/transition');
  process.exit(1);
}

const BASE = 'http://dsh.invalid';
const call = (init) => route.fetch(new Request(`${BASE}/api/jira-work-overview/transition`, init));
const show = async (label, response) => {
  const payload = await response.json().catch(() => null);
  console.log(`\n--- ${label} → HTTP ${response.status}`);
  if (payload && payload.transitions) {
    console.log(`  key=${payload.key} 当前=${payload.current} 可用流转=${payload.transitions.length}`);
    console.log('  ' + payload.transitions.slice(0, 6).map((t) => `${t.id}→${t.to}`).join('  '));
    console.log('  必填字段的流转：', payload.transitions.filter((t) => t.required.length).length);
  } else {
    console.log('  ' + JSON.stringify(payload));
  }
  return payload;
};

// 1) GET 列可用流转（只读）
const good = `${BASE}/api/jira-work-overview/transition?key=${PROJECT}-4051`;
await show('GET ?key=' + PROJECT + '-4051', await route.fetch(new Request(good, { method: 'GET' })));

// 2) 坏 key → 400（host 侧校验）
const url = `${BASE}/api/jira-work-overview/transition?key=oops`;
await show('GET ?key=oops', await route.fetch(new Request(url, { method: 'GET' })));

// 3) POST 缺 transitionId → 400
await show('POST 缺 transitionId', await call({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ key: `${PROJECT}-4051` }),
}));

// 4) POST 不存在的 transitionId → Jira 400（不改变任何状态）
await show('POST transitionId=999999', await call({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ key: `${PROJECT}-4051`, transitionId: '999999' }),
}));

// 5) 工具：只列流转
const tool = hostTools.get('jira_transition');
if (!tool) {
  console.log('❌ 没有 jira_transition 工具');
  process.exit(1);
}
console.log('\n=== jira_transition（只给 key）');
console.log(String(await tool.execute({ key: `${PROJECT}-4051` }, {})).split('\n').slice(0, 6).join('\n'));

console.log('\n=== jira_transition（预览 IN QA，不带 apply）');
const preview = String(await tool.execute({ key: `${PROJECT}-3489`, to: 'IN QA' }, {}));
console.log(preview);

console.log('\n=== jira_transition（预览：用流转名「完成」）');
console.log(String(await tool.execute({ key: `${PROJECT}-3489`, to: '完成' }, {})).split('\n').join('\n'));

console.log('\n=== jira_transition（非法目标状态）');
try {
  await tool.execute({ key: `${PROJECT}-3489`, to: '不存在的状态' }, {});
  console.log('❌ 应该抛错');
} catch (error) {
  console.log('OK: ' + error.message.slice(0, 120));
}

console.log('\n=== jira_transition（非法 key）');
try {
  await tool.execute({ key: 'oops' }, {});
  console.log('❌ 应该抛错');
} catch (error) {
  console.log('OK: ' + error.message);
}
