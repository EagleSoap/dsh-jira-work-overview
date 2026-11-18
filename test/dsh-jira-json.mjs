import { mkdirSync, existsSync } from 'node:fs';
// 结构化输出（--json）的端到端验证：直接 import 工作区里的插件，用真实 Jira 数据。
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/* --- 跨平台：临时目录与本机凭据文件（Windows 上用 os.tmpdir()，可用 DSH_JIRA_TMP 覆盖） --- */
const TMP = process.env.DSH_JIRA_TMP || (existsSync(join('/tmp', '.dsh_jira_env')) ? '/tmp' : tmpdir());
const HOST_COPY = join(TMP, 'dsh-jira-smoke3', 'index.js');
const ENV_FILE = process.env.DSH_JIRA_ENV_FILE || join(TMP, '.dsh_jira_env');
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
  projectKey: 'APP',
  boardId: 42,
  credentialKey: 'JIRA_API_TOKEN',
  maxResults: 50,
  timeoutMs: 30000,
}));
await new Promise((r) => setTimeout(r, 300));

console.log('tools registered:', toolCount, '| command:', registered ? `${registered.name} hint=${registered.input.hint}` : '无');

const list = await registered.handler({ rawInput: '--json' });
console.log(`\n/jira --json → kind=${list.kind}`);
const payload = JSON.parse(list.text);
console.log('顶层字段:', Object.keys(payload).join(', '));
console.log('query:', JSON.stringify(payload.query));
console.log('credentialSource:', payload.credentialSource);
console.log('sprint:', JSON.stringify(payload.sprint));
console.log('counts:', JSON.stringify(payload.counts));
console.log('items:', payload.items.length);
for (const item of payload.items.slice(0, 3)) {
  console.log('  ·', item.key, '|', item.category, '|', item.status, '|', item.priority, '|', item.summary.slice(0, 28), '|', item.url);
}

const filtered = await registered.handler({ rawInput: '--json project = APP AND duedate is not EMPTY' });
const due = JSON.parse(filtered.text);
console.log('\n/jira --json <JQL> → 总数', due.counts.total, '| 逾期', due.items.filter((i) => i.overdue).map((i) => i.key).join('、'));

const one = await registered.handler({ rawInput: '--json APP-4051' });
const detail = JSON.parse(one.text);
console.log('/jira --json APP-4051 →', detail.item.key, '|', detail.item.status, '| 描述长度', detail.item.description.length, '| 模块', JSON.stringify(detail.item.components));

const plain = await registered.handler({ rawInput: '' });
console.log('\n/jira（纯文本回归）→ kind=' + plain.kind + ' | 首行: ' + plain.text.split('\n')[0]);
