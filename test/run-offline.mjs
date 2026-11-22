/**
 * 一次跑完所有离线套件（CI 与本地共用）：`node test/run-offline.mjs`。
 *
 * 每个套件都是独立进程，一个挂了不会污染别的；最后汇总，任一非 0 退出即整轮失败。
 * 加 `--release` 时会把 `--release` 透传给发版预检（要求 CHANGELOG 定稿、[Unreleased] 已清空）。
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WS = dirname(dirname(fileURLToPath(import.meta.url)));
const RELEASE = process.argv.includes('--release');

// 真站点套件（status / transition / sprint / smoke*）在没凭据时会自己 SKIP 并 exit 0。
const SUITES = [
  'bundle-id', 'release', 'platform', 'visual', 'credential', 'plan', 'workspace-menu', 'i18n',
  'search', 'epic', 'selfwatch', 'json', 'smoke', 'smoke3', 'due', 'sprint', 'status', 'transition',
];

const failed = [];
for (const suite of SUITES) {
  const args = [join(WS, 'test', `dsh-jira-${suite}.mjs`)];
  if (RELEASE && suite === 'release') args.push('--release');
  console.log(`\n=== ${suite}`);
  const run = spawnSync(process.execPath, args, { cwd: WS, stdio: 'inherit' });
  if (run.status !== 0) failed.push(suite);
}

console.log(`\n=== 离线套件：${SUITES.length - failed.length}/${SUITES.length} 通过 ===`);
if (failed.length) {
  console.log(`失败：${failed.join(', ')}`);
  process.exit(1);
}
