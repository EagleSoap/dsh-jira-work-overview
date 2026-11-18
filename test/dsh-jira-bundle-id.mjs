// 离线回归：client bundle 注册的 id 必须等于包名。
//
// 背景（2026-11-19）：包从 `@local/dsh-jira-work-overview` 改名为 `dsh-jira-work-overview` 时，
// `client.js` 里 `window.__ModuleLoader__.load({ id })` 的 id 忘了跟着改，host 的 client-modules
// 按包名物化 bundle，只报
//   `client-modules: bundle <url> loaded without registering "<包名>" via __ModuleLoader__.load`
// 于是 client 半边整个不加载：左侧栏入口、浮层面板、三个配置页一起静默消失，
// 而 host 半边照样 `fiberPhase: "active"`，从 plugin_manager 完全看不出来。
// 这个套件把「包名 / patch 行名 / bundle id 三处一致」钉死，改名字时漏一处就红。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const client = readFileSync(join(ROOT, 'client.js'), 'utf8');
const patch = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8');

let failed = 0;
const check = (ok, label, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : ` | ${detail}`}`);
  if (!ok) failed += 1;
};

/* ------------------------------------------------ bundle id === 包名 */

// `load({` 和 `id:` 之间允许注释 / 换行（本次事故就是在这中间补了一段注释）。
const loadCalls = [...client.matchAll(/__ModuleLoader__\.load\(\{([\s\S]{0,600}?)\)?\s*factory\(require\)/g)].map((m) => m[1]);
const loadIds = loadCalls.map((body) => body.match(/(?:^|\s)id:\s*'([^']+)'/)?.[1]);
check(loadIds.length === 1, 'client.js 只有一处 __ModuleLoader__.load', `找到 ${loadIds.length} 处`);
check(loadIds[0] === pkg.name, 'bundle 注册的 id 等于 package.json 的 name', `${loadIds[0]} vs ${pkg.name}`);

/* ------------------------------------------------ patch 行名 === 包名（AGENTS 不变量） */

const inserted = [...patch.matchAll(/name:\s*'([^']+)'/g)].map((m) => m[1]);
check(
  inserted.includes(pkg.name),
  'cordis.patch.yml 的 insert[].name 等于 package.json 的 name',
  `insert 里是 ${inserted.join(', ') || '(无)'}，包名是 ${pkg.name}`,
);

/* ------------------------------------------------ 没有改名残留 */

for (const [file, text] of [
  ['client.js', client],
  ['cordis.patch.yml', patch],
  ['package.json', JSON.stringify(pkg)],
]) {
  check(!/@local\//.test(text), `${file} 里没有 @local/ 残留（改名必须同名替换）`);
}

/* ------------------------------------------------ client 半边确实是按宿主模块表加载的 */

check(
  /__ModuleLoader__\.load\(\{[\s\S]{0,600}?factory\(require\)\s*\{/.test(client),
  'client.js 仍是 { id, factory(require) } 的 bundle 形式',
);
for (const word of ['react']) {
  check(client.includes(`require('${word}')`), `client.js 从宿主模块表取 ${word}`);
}
check(
  !/require\(['"]@deepseek-ai\//.test(client),
  'client.js 不 require 任何 @deepseek-ai/* 包（基座模块表契约）',
);

console.log(failed === 0 ? '\n=== bundle id 测试：全部通过 ===' : `\n=== bundle id 测试：${failed} 项失败 ===`);
process.exit(failed === 0 ? 0 : 1);
