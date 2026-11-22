/**
 * 发版预检（纯文件 + npm + git，离线）：不 import `index.js`，所以**不需要宿主依赖**，
 * 在 CI / 干净机器 / 发版前都能直接跑。
 *
 *   node test/dsh-jira-release.mjs              # PR / push 的常规检查
 *   node test/dsh-jira-release.mjs --release    # 发版前：额外要求 CHANGELOG 的当前版本条目已定稿、
 *                                               # [Unreleased] 已清空、tag（若在 tag 上）与 version 一致
 *
 * 查的是「发出去的那份东西对不对」：
 *   1. `package.json` 自身：零运行时依赖、exports/`files` 指向的文件真存在、publishConfig 指官方 registry；
 *   2. bundle 身份三处一致（package.json.name / cordis.patch.yml / client.js 的 __ModuleLoader__.load）；
 *   3. `CHANGELOG.md` 有当前版本的条目（发版模式下还要求它是第一条且 [Unreleased] 为空）；
 *   4. 脱敏：仓库里不得出现个人站点 / 姓名 / 看板 id / 令牌片段；
 *   5. `npm pack --dry-run` 的**真实文件清单**包含 `files` 里的每一项（防止 .npmignore / files 漏项把
 *      图片、locale、客户端半边挤出 tarball）。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const WS = dirname(dirname(fileURLToPath(import.meta.url)));
const RELEASE = process.argv.includes('--release') || String(process.env.GITHUB_REF_NAME ?? '').startsWith('v');
const results = [];
const fail = [];

function check(label, ok, extra = '') {
  results.push(ok === true);
  console.log(`${ok === true ? 'PASS' : 'FAIL'}  ${label}${extra ? ` | ${extra}` : ''}`);
  if (!ok) fail.push(label);
}

const read = (name) => readFileSync(join(WS, name), 'utf8');
const pkg = JSON.parse(read('package.json'));

/* ---------------------------------------------------------------- 1) package.json */

check('version 是 semver', /^\d+\.\d+\.\d+$/.test(pkg.version), pkg.version);
check('没有运行时 dependencies（插件零依赖）', !pkg.dependencies || Object.keys(pkg.dependencies).length === 0, JSON.stringify(pkg.dependencies ?? {}));
check('peerDependencies 声明了 @deepseek-ai/schemastery', Boolean(pkg.peerDependencies?.['@deepseek-ai/schemastery']), JSON.stringify(pkg.peerDependencies ?? {}));
check('publishConfig 指向官方 registry', pkg.publishConfig?.registry === 'https://registry.npmjs.org', String(pkg.publishConfig?.registry));
check('publishConfig.access = public', pkg.publishConfig?.access === 'public', String(pkg.publishConfig?.access));
check('engines.node 有下限', /^>=\d+/.test(String(pkg.engines?.node ?? '')), String(pkg.engines?.node));
check('没有 postinstall / preinstall 之类的安装脚本', !pkg.scripts || !Object.keys(pkg.scripts).some((name) => /^(pre|post)?install$/.test(name)), JSON.stringify(pkg.scripts ?? {}));
check('dsh.bundle.patch 指向 cordis.patch.yml', pkg.dsh?.bundle?.patch === './cordis.patch.yml' && existsSync(join(WS, 'cordis.patch.yml')), String(pkg.dsh?.bundle?.patch));

for (const [key, value] of Object.entries(pkg.exports ?? {})) {
  const targets = typeof value === 'string' ? { default: value } : value;
  for (const [condition, target] of Object.entries(targets)) {
    if (target.includes('*')) continue; // "./locale/*.json"
    check(`exports["${key}"].${condition} 的文件存在`, existsSync(join(WS, target)), target);
  }
}

for (const entry of pkg.files ?? []) {
  check(`files 里的 "${entry}" 存在`, existsSync(join(WS, entry)), entry);
}

/* ---------------------------------------------------------------- 2) bundle 身份三处一致 */

const bundleName = pkg.name;
check('cordis.patch.yml 里 name 与包名一致', read('cordis.patch.yml').includes(`name: '${bundleName}'`), bundleName);
check('client.js 的 __ModuleLoader__.load({ id }) 与包名一致',
  new RegExp(`__ModuleLoader__\\s*\\.\\s*load\\(\\s*\\{[^}]*\\bid:\\s*['"]${bundleName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`).test(read('client.js')),
  bundleName);
check('locale 元数据（en/zh）都有 title + description', ['en', 'zh'].every((lang) => {
  const meta = JSON.parse(read(`locale/${lang}.json`)).meta ?? {};
  return String(meta.title ?? '').length > 0 && String(meta.description ?? '').length > 0;
}), '');

/* ---------------------------------------------------------------- 3) CHANGELOG */

const changelog = read('CHANGELOG.md');
const sections = [...changelog.matchAll(/^## \[?([^\]\n]+?)\]?(?:\s*-\s*([^\n]+))?$/gm)];
const current = sections.find((row) => row[1].trim() === pkg.version);
check(`CHANGELOG 有 ${pkg.version} 的条目`, Boolean(current), sections.slice(0, 3).map((row) => row[1].trim()).join(' → '));

if (current) {
  const at = current.index ?? 0;
  const nextHeading = changelog.indexOf('\n## ', at + 1);
  const body = changelog.slice(at, nextHeading === -1 ? undefined : nextHeading).trim();
  check(`${pkg.version} 的条目不是空壳`, body.split('\n').length > 3, `${body.length} 字符`);
  check(`${pkg.version} 的条目带日期`, /^\d{4}-\d{2}-\d{2}$/.test(String(current[2] ?? '').trim()), String(current[2] ?? '').trim());
  check('CHANGELOG 的最新版本就是当前版本', sections.find((row) => row[1].trim() !== 'Unreleased')?.[1].trim() === pkg.version,
    sections.map((row) => row[1].trim()).slice(0, 3).join(' → '));
}

if (RELEASE) {
  const unreleased = changelog.match(/^## \[Unreleased\]\s*([\s\S]*?)(?=^## |\z)/m);
  const leftover = (unreleased?.[1] ?? '').trim();
  check('发版时 [Unreleased] 已清空（内容并进版本条目）', leftover === '', leftover ? `${leftover.split('\n').length} 行未归档` : '');

  const tag = String(process.env.GITHUB_REF_NAME ?? '');
  if (tag.startsWith('v')) {
    check(`tag ${tag} 与 package.json version 一致`, tag.replace(/^v/, '') === pkg.version, `${tag} vs v${pkg.version}`);
  }
}

/* ---------------------------------------------------------------- 4) 脱敏 */

// 片段拼接：让这个文件本身不含被禁的字面量，`git grep` 才不会自己命中自己。
const FORBIDDEN = [
  ['FT', 'U'], ['/Users/', 'soap'], ['F', '639'], ['Dev Test ', 'Done'], ['费', '召洪'], ['boardId: ', '99'],
];
for (const parts of FORBIDDEN) {
  const pattern = parts.join('');
  let hits = '';
  try {
    hits = execFileSync('git', ['grep', '-nI', '-E', '-e', pattern, '--', '.'], { cwd: WS, encoding: 'utf8' });
  } catch (error) {
    if (error?.status === 1) hits = ''; // 没有命中：git grep 用 1 表示「没找到」
    else hits = `__git_grep_error__:${error?.message ?? error}`;
  }
  const lines = hits.split('\n').filter(Boolean);
  check(`仓库里没有「${parts.length > 1 ? parts[0] + '…' : pattern}」${parts.length > 1 ? '（片段拼接检测）' : ''}`,
    lines.length === 0, lines.slice(0, 2).join(' / '));
}

/* ---------------------------------------------------------------- 5) npm pack 的真实清单 */

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const packed = spawnSync(npmCmd, ['pack', '--dry-run', '--json'], { cwd: WS, encoding: 'utf8', shell: process.platform === 'win32' });
let manifest = null;
try {
  manifest = JSON.parse(packed.stdout ?? '[]')[0] ?? null;
} catch {
  manifest = null;
}
check('npm pack --dry-run 能跑通', manifest !== null, (packed.stderr ?? '').split('\n').slice(0, 2).join(' '));

if (manifest) {
  const names = (manifest.files ?? []).map((row) => row.path);
  const missing = (pkg.files ?? []).filter((entry) => !names.some((name) => name === entry || name.startsWith(`${entry}/`)));
  check('tarball 包含 files 里的每一项', missing.length === 0, missing.join(', '));
  for (const required of ['package.json', 'index.js', 'client.js', 'cordis.patch.yml']) {
    check(`tarball 里有 ${required}`, names.includes(required), '');
  }
  check('tarball 里没有 .git / node_modules / .DS_Store',
    !names.some((name) => /(^|\/)(\.git|node_modules|\.DS_Store)/.test(name)), '');
  check('tarball 里没有真令牌片段（ATATT 开头 40 位以上）',
    !(manifest.files ?? []).some((row) => /ATATT3[A-Za-z0-9_-]{40,}/.test(String(row.path))), '');
  const size = Number(manifest.size ?? manifest.unpackedSize ?? 0);
  check('tarball 体积在合理区间（0 < size < 8MB）', size > 0 && size < 8 * 1024 * 1024, `${size} bytes, ${(manifest.files ?? []).length} files`);
  check('tarball 里没有绝对路径条目', !names.some((name) => name.startsWith('/') || /^[A-Za-z]:/.test(name)), '');
  // 用户拿到的是这个 tarball：README 的安装方式必须指向包名本身。
  const readme = read('README.md');
  check('README 的安装说明指向包名', readme.includes(`install_bundle(target="${bundleName}")`), bundleName);
  check('README.zh.md 与 README.md 都在包里', names.includes('README.md') && names.includes('README.zh.md'), '');
}

/* ---------------------------------------------------------------- 收尾 */

void relative;
const failed = results.filter((value) => value !== true).length;
console.log(`\n=== 发版预检${RELEASE ? '（release 模式）' : ''}：${results.length - failed}/${results.length} 通过 ===`);
if (failed) console.log(`失败项：\n- ${fail.join('\n- ')}`);
process.exit(failed === 0 ? 0 : 1);
