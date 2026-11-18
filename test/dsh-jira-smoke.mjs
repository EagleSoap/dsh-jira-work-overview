import { mkdirSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/* --- 跨平台：临时目录与本机凭据文件（Windows 上用 os.tmpdir()，可用 DSH_JIRA_TMP 覆盖） --- */
const TMP = process.env.DSH_JIRA_TMP || (existsSync(join('/tmp', '.dsh_jira_env')) ? '/tmp' : tmpdir());
const HOST_COPY = join(TMP, 'dsh-jira-smoke3', 'index.js');
const ENV_FILE = process.env.DSH_JIRA_ENV_FILE || join(TMP, '.dsh_jira_env');
mkdirSync(join(TMP, 'dsh-jira-smoke3'), { recursive: true });

const envText = fs.readFileSync(ENV_FILE, 'utf8');
const readEnv = (key) => {
  const m = envText.match(new RegExp(`^${key}=(.*)$`, 'm'));
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : undefined;
};

const PLUGIN = '/path/to/Project/dsh plugins/dsh-jira-work-overview/index.js';
const mod = await import(pathToFileURL(PLUGIN).href);

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
  projectKey: 'APP',
  boardId: 42,
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

console.log('\n===== jira_my_work scope=open limit=10 =====');
console.log(await work.execute({ scope: 'open', limit: 10 }, {}));

console.log('\n===== jira_my_work scope=sprint limit=10 =====');
console.log(await work.execute({ scope: 'sprint', limit: 10 }, {}));

console.log('\n===== jira_issue APP-3489 (comments) =====');
console.log(await issue.execute({ key: 'APP-3489', comments: true, comment_limit: 3 }, {}));

console.log('\n===== bad key handling =====');
try {
  await issue.execute({ key: 'oops' }, {});
  console.log('BAD: no error thrown');
} catch (error) {
  console.log('OK:', error.message);
}
