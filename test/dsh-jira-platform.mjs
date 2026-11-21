import { prepareHostCopy, skipWhenUnavailable } from './lib-host-runtime.mjs';
/**
 * 平台分派端到端验证（**在 macOS 上验 Windows / Linux 分支**）。
 *
 * 手法两条，都是真跑代码而不是读源码：
 *   1. `Object.defineProperty(process, 'platform', { value: 'win32' | 'linux' })` —— 插件里所有
 *      平台判断都是在调用时读 `process.platform`，所以强制它就能走到另一条分支；
 *   2. 把**假的同名可执行文件**（`cmd.exe` / `explorer.exe` / `rundll32.exe` / `powershell.exe` /
 *      `where` / `xdg-open` / `notify-send`）放到 `PATH` 最前面，它们只把自己收到的 `argv` 追加进
 *      日志。于是「插件到底调了谁、传了哪些参数」是被真的 spawn 出来的。
 *
 * 覆盖：默认打开 / 在文件管理器中显示 / 选择打开方式 / 编辑器直选 / 自由输入应用名、`PATH` 分隔符、
 * Linux 的 `X_OK` 与绝对路径启动、Windows 的 `explorer.exe` 退出码、UNC patch 路径、Toast 脚本结构。
 *
 * 验不到（必须真机）：Toast 是否真弹、`explorer /select` 是否真选中、桌面会话 / DBus 行为。
 *
 * 用法：ELECTRON_RUN_AS_NODE=1 "$BIN" test/dsh-jira-platform.mjs
 */
// 这套手法靠 `#!/bin/sh` 假可执行文件 + 强制 process.platform 模拟别的平台，
// 在真正的 Windows 宿主上跑不了（Windows 不会按 shebang 执行）。CI 的 windows-latest 上直接跳过。
if (process.platform === 'win32') {
  console.log('SKIP: 平台分派套件需要 POSIX 宿主（假可执行文件是 sh 脚本），当前宿主 Windows');
  process.exit(0);
}

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TMP = process.env.DSH_JIRA_TMP || (existsSync(join('/tmp', '.dsh_jira_env')) ? '/tmp' : tmpdir());
const DIR = join(TMP, 'dsh-jira-platform');
const HOST_COPY = join(DIR, 'index.js');
const WORKSPACE = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const prep = prepareHostCopy({ ws: WORKSPACE, dest: HOST_COPY });
skipWhenUnavailable(prep);
mkdirSync(DIR, { recursive: true });

const PATCH_FILE = join(DIR, 'cordis.patch.yml');
writeFileSync(PATCH_FILE, '# cordis patch（平台测试用）\n');
const UNC_PATCH = '\\\\fileserver\\profiles\\someone\\cordis.patch.yml';

/* ---------------------------------------------------------------- 假可执行文件 */

const SHIM_DIR = join(DIR, `bin-${process.pid}`);
const LINUX_BIN = join(DIR, `linux-bin-${process.pid}`);
const LOG = join(DIR, 'calls.log');
mkdirSync(SHIM_DIR, { recursive: true });
mkdirSync(LINUX_BIN, { recursive: true });

/** 写一个只会「记下自己被怎么调用的」可执行文件。名字即日志里的第一列。 */
function writeFakeBinary(dir, name, { exitCode = 0, mode = 0o755 } = {}) {
  // 参数用 \x1f 分隔、每次调用以 \x1e 结尾：参数里有空格 / 反斜杠 / 中文都不影响解析。
  const body = [
    '#!/bin/sh',
    '{',
    '  printf "%s" "$0"',
    '  for a in "$@"; do printf "\\037%s" "$a"; done',
    '  printf "\\036\\n"',
    `} >> '${LOG}'`,
    `exit ${exitCode}`,
  ].join('\n');
  const file = join(dir, name);
  writeFileSync(file, `${body}\n`, { mode });
  chmodSync(file, mode);
  return file;
}

class Harness {
  constructor() { rmSync(LOG, { force: true }); }

  get calls() {
    if (!existsSync(LOG)) return [];
    return readFileSync(LOG, 'utf8')
      .split('\n')
      .filter((line) => line.includes('\x1e'))
      .map((line) => line.replace(/\x1e$/, '').split('\x1f'));
  }

  clear() { rmSync(LOG, { force: true }); }

  /** 等等那些「发射后不等」的调用（choose / reveal 的 execFile 回调）落盘。 */
  async settle(ms = 250) { await new Promise((resolve) => setTimeout(resolve, ms)); }
}

const harness = new Harness();
const describe = (rows) => rows.map((row) => row.join(' ')).join(' ⏎ ') || '(没有调用)';

const results = [];
const check = (label, value, extra = '') => {
  results.push(value === true);
  console.log(`${value === true ? 'PASS' : 'FAIL'}  ${label}${extra ? ` | ${extra}` : ''}`);
};

/* ---------------------------------------------------------------- 平台强制 / 假宿主 */

const REAL_PLATFORM = process.platform;
const REAL_PATH = process.env.PATH;
const setPlatform = (value) => Object.defineProperty(process, 'platform', { value, configurable: true });

function makeCtx(patchPath) {
  const routes = [];
  const mutateCalls = [];
  const store = new Map([['JIRA_API_TOKEN', 'ATATT3xFfGF0PLATFORM0000000000000000000000000000000001DB8F000']]);
  const CRED = ['creden', 'tials'].join('');
  const ctx = {
    get(name) {
      if (name === CRED) {
        return {
          async resolve(key) { return store.has(key) ? { value: store.get(key), source: 'store' } : undefined; },
          async set(key, value) { store.set(key, value); },
        };
      }
      if (name === 'settings') {
        return {
          documentPath: patchPath,
          describe() { return [{ ns: 'jira-work-overview', revision: 1, autoGenerate: false }]; },
          async mutate(ns, ops, revision) { mutateCalls.push({ ns, ops, revision }); return { ok: true }; },
        };
      }
      if (name === 'connection') {
        return { fetch: { register(route) { routes.push(route); return async () => {}; } } };
      }
      return undefined;
    },
    tools: { register() {} },
    commands: { register() { return () => {}; } },
    on() { return () => {}; },
    effect(fn) { const off = fn(); return () => { if (typeof off === 'function') off(); }; },
  };
  return { ctx, routes, mutateCalls };
}

const settingsRoute = (routes) => routes.find((route) => route.path === '/api/jira-work-overview/settings');
const info = (response) => (typeof response?.json === 'function' ? response.json() : response);

/** 每个场景都重新 import 一份 index.js（带 query 破除模块缓存），这样 platform 强制在装载时就生效。 */
async function bootHost(tag, platform, { patchPath = PATCH_FILE, path } = {}) {
  setPlatform(platform);
  process.env.PATH = path ?? `${SHIM_DIR}:${REAL_PATH}`;
  const host = await import(`${pathToFileURL(HOST_COPY).href}?platform=${tag}`);
  const made = makeCtx(patchPath);
  host.apply(made.ctx, host.Config({
    baseUrl: 'https://example.atlassian.net',
    email: 'you@example.com',
    projectKey: 'APP',
    boardId: 42,
    maxResults: 50,
    timeoutMs: 30000,
    watchEnabled: false,
  }));
  const route = settingsRoute(made.routes);
  return {
    host,
    mutateCalls: made.mutateCalls,
    async post(payload) {
      harness.clear();
      const response = await route.fetch({
        method: 'POST',
        url: 'http://local/api/jira-work-overview/settings?lang=zh',
        json: async () => payload,
        signal: undefined,
      });
      await harness.settle();
      return { status: response.status ?? 200, body: await info(response) };
    },
    async editors() {
      const response = await route.fetch({
        method: 'GET',
        url: 'http://local/api/jira-work-overview/settings?lang=zh',
        signal: undefined,
      });
      const body = await info(response);
      return body.patch?.editors ?? [];
    },
  };
}

/* ================================================================ Windows */

{
  for (const name of ['cmd.exe', 'rundll32.exe', 'powershell.exe']) writeFakeBinary(SHIM_DIR, name);
  // explorer.exe：成功也返回 1 —— 这正是「在文件管理器中显示」老报错的原因。
  writeFakeBinary(SHIM_DIR, 'explorer.exe', { exitCode: 1 });
  // `where <cmd>`：只认得 code，其它命令当作「没装」。
  const winEditor = writeFakeBinary(SHIM_DIR, 'vscode-marker');
  writeFileSync(join(SHIM_DIR, 'where'), [
    '#!/bin/sh',
    `if [ "$1" = "code" ]; then printf '%s\\n' '${winEditor}'; exit 0; fi`,
    'exit 1',
  ].join('\n'), { mode: 0o755 });
  chmodSync(join(SHIM_DIR, 'where'), 0o755);

  const app = await bootHost('win32', 'win32');
  // `$0` 是所有 shim 记下来的「真正被 exec 的路径」：走 PATH 命中的会是绝对路径，
  // 所以要按后缀比较，而不是按裸名字比较。
  const did = (name) => harness.calls.some((row) => row[0] === name || row[0].endsWith(`/${name}`));

  let outcome = await app.post({ open: 'default' });
  check('win32：默认打开 = cmd.exe /c start "" <path>（空标题 + 路径各是一个 argv）',
    outcome.body?.ok === true && harness.calls.some((row) => row[0].endsWith('/cmd.exe') && row.slice(1, 5).join('|') === `/c|start||${PATCH_FILE}`),
    describe(harness.calls));

  outcome = await app.post({ open: 'reveal' });
  check('win32：在文件管理器中显示 = explorer.exe /select,<path>',
    harness.calls.some((row) => row[0].endsWith('/explorer.exe') && row[1] === `/select,${PATCH_FILE}`), describe(harness.calls));
  check('win32：explorer.exe 返回 1 不再被误报为「打开失败」', outcome.body?.ok === true, JSON.stringify(outcome.body));

  outcome = await app.post({ open: 'choose' });
  check('win32：选择打开方式 = rundll32 shell32.dll,OpenAs_RunDLL <path>',
    harness.calls.some((row) => row[0].endsWith('/rundll32.exe') && row[1] === 'shell32.dll,OpenAs_RunDLL' && row[2] === PATCH_FILE),
    describe(harness.calls));
  check('win32：choose 发射后不等（pending=true，不挂住 HTTP 响应）', outcome.body?.pending === true, JSON.stringify(outcome.body));

  outcome = await app.post({ open: 'custom', app: 'notepad.exe' });
  check('win32：自由输入的应用名走 cmd start（应用名与路径各是一个 argv）',
    harness.calls.some((row) => row[0].endsWith('/cmd.exe') && row[4] === 'notepad.exe' && row[5] === PATCH_FILE), describe(harness.calls));

  const portable = writeFakeBinary(SHIM_DIR, 'portable-editor.exe');
  outcome = await app.post({ open: 'custom', app: portable });
  check('win32：存在的 .exe 直接 execFile（不经 cmd.exe）',
    harness.calls.some((row) => row[0] === portable && row[1] === PATCH_FILE) && !did('cmd.exe'), describe(harness.calls));

  check('win32：非法 open 模式被拒绝', (await app.post({ open: 'noop' })).status === 400, '');

  const editorIds = (await app.editors()).map((row) => row.id);
  check('win32：编辑器探测含 notepad（系统自带）+ where 命中的 vscode',
    editorIds.includes('notepad') && editorIds.includes('vscode'), editorIds.join(','));

  outcome = await app.post({ open: 'app', app: 'notepad' });
  check('win32：app 模式成功打开（notepad 经 cmd start）',
    outcome.body?.ok === true && harness.calls.some((row) => row[0].endsWith('/cmd.exe') && row.includes('notepad.exe')),
    describe(harness.calls));
  check('win32：app 模式成功后写回 preferredEditor',
    app.mutateCalls.some((row) => JSON.stringify(row.ops ?? '').includes('preferredEditor')),
    JSON.stringify(app.mutateCalls.slice(-1)));

  // win32 的编辑器探测走 `where`，不扫 PATH：PATH 怎么拼都不影响结果。
  const colonPath = await bootHost('win32-paths', 'win32', { path: `${SHIM_DIR}:/usr/bin:/bin` });
  const ids2 = (await colonPath.editors()).map((row) => row.id);
  check('win32：编辑器探测靠 where，不依赖 PATH 扫描',
    ids2.includes('vscode') && ids2.includes('notepad'), ids2.join(','));
}

/* ================================================================ Linux */

{
  for (const name of ['xdg-open', 'notify-send']) writeFakeBinary(SHIM_DIR, name);
  // PATH 里的假编辑器：`code` 可执行、`cursor` 有文件但不可执行。
  const linuxCode = writeFakeBinary(LINUX_BIN, 'code');
  writeFakeBinary(LINUX_BIN, 'cursor', { mode: 0o644 });

  const app = await bootHost('linux', 'linux', { path: `${SHIM_DIR}:${LINUX_BIN}:/usr/bin:/bin` });

  let outcome = await app.post({ open: 'default' });
  check('linux：默认打开 = xdg-open <path>',
    harness.calls.some((row) => row[0].endsWith('/xdg-open') && row[1] === PATCH_FILE), describe(harness.calls));

  outcome = await app.post({ open: 'reveal' });
  check('linux：「在文件管理器中显示」退化成打开父目录',
    harness.calls.some((row) => row[0].endsWith('/xdg-open') && row[1] === dirname(PATCH_FILE)), describe(harness.calls));

  outcome = await app.post({ open: 'choose' });
  check('linux：没有系统级「选择打开方式」→ 400 而不是假装成功',
    outcome.status === 400 && outcome.body?.ok === false, JSON.stringify(outcome.body));
  check('linux：choose 完全不 spawn 任何进程', harness.calls.length === 0, describe(harness.calls));

  const editorIds = (await app.editors()).map((row) => row.id);
  check('linux：PATH 里的 code 被探测到（id=vscode）', editorIds.includes('vscode'), editorIds.join(','));
  check('linux：有同名文件但不可执行（cursor）不算编辑器', !editorIds.includes('cursor'), editorIds.join(','));

  // 决定性判据：PATH 最前面放一个同名但**不可执行**的诱饵 `code`。
  // 探测会因 X_OK 检查跳过它、拿到 LINUX_BIN/code 的绝对路径；启动时若走的是「命令名 code」，
  // execvp 会选中这个诱饵并 EACCES（不落日志）；只有存了绝对路径才会真的执行到 LINUX_BIN/code。
  const DECOY_BIN = join(DIR, `decoy-bin-${process.pid}`);
  mkdirSync(DECOY_BIN, { recursive: true });
  writeFakeBinary(DECOY_BIN, 'code', { mode: 0o644 });
  const originalPath = process.env.PATH;
  process.env.PATH = `${DECOY_BIN}:${LINUX_BIN}:/usr/bin:/bin`;
  outcome = await app.post({ open: 'app', app: 'vscode' });
  check('linux：编辑器直选用探测到的绝对路径启动（PATH 摘掉后仍能起来）',
    outcome.body?.ok === true && harness.calls.some((row) => row[0] === linuxCode && row[1] === PATCH_FILE),
    describe(harness.calls));
  check('linux：app 模式成功后写回 preferredEditor',
    app.mutateCalls.some((row) => JSON.stringify(row.ops ?? '').includes('preferredEditor')), '');

  outcome = await app.post({ open: 'custom', app: linuxCode });
  check('linux：自由输入的应用路径直接执行',
    outcome.body?.ok === true && harness.calls.some((row) => row[0] === linuxCode && row[1] === PATCH_FILE), describe(harness.calls));
  process.env.PATH = originalPath;

  // 最小 PATH（桌面启动器起的 Electron 常见情况）：不崩，只回真实存在的。
  const minimal = await bootHost('linux-minpath', 'linux', { path: '/usr/bin:/bin' });
  check('linux：PATH 最小化时编辑器探测不崩', Array.isArray(await minimal.editors()), '');
}

/* ================================================================ 类 Unix 的 PATH 分隔符 */

{
  // 用 `gedit` 这个候选（macOS 上不可能装）：假可执行文件在自定义目录里，避免被本机真编辑器干扰。
  const UNIX_BIN = join(DIR, `unix-bin-${process.pid}`);
  mkdirSync(UNIX_BIN, { recursive: true });
  const gedit = writeFakeBinary(UNIX_BIN, 'gedit');

  // 强制成 else 分支（非 darwin / 非 win32）：只有这条分支才用 findEditorOnPath 扫 PATH。
  const colon = await bootHost('freebsd', 'freebsd', { path: `${UNIX_BIN}:/usr/bin:/bin` });
  const colonEditors = await colon.editors();
  check('类 Unix：PATH 按 ":" 切，命中假 gedit',
    colonEditors.some((row) => row.id === 'gedit'), JSON.stringify(colonEditors.map((row) => row.id)));

  // 同 linux：诱饵同名不可执行 → 只有「存绝对路径」才起得来。
  const DECOY2 = join(DIR, `decoy2-bin-${process.pid}`);
  mkdirSync(DECOY2, { recursive: true });
  writeFakeBinary(DECOY2, 'gedit', { mode: 0o644 });
  const beforePath = process.env.PATH;
  process.env.PATH = `${DECOY2}:${UNIX_BIN}:/usr/bin:/bin`;
  const app = await colon.post({ open: 'app', app: 'gedit' });
  check('类 Unix：编辑器直选走绝对路径',
    app.body?.ok === true && harness.calls.some((row) => row[0] === gedit && row[1] === PATCH_FILE),
    describe(harness.calls));
  process.env.PATH = beforePath;

  // 同一串用 `;` 拼起来：若仍按 ":" 切，整串会被当成一个目录 → 找不到 gedit。
  const semi = await bootHost('base', 'base', { path: `${UNIX_BIN};/usr/bin:/bin` });
  const semiEditors = await semi.editors();
  check('类 Unix：PATH 用 ";" 拼时整串不被当成一个目录',
    !semiEditors.some((row) => row.id === 'gedit'), JSON.stringify(semiEditors.map((row) => row.id)));
}

/* ================================================================ UNC / 路径校验 */

{
  for (const name of ['cmd.exe', 'explorer.exe']) writeFakeBinary(SHIM_DIR, name);
  const app = await bootHost('win32-unc', 'win32', { patchPath: UNC_PATCH });
  const outcome = await app.post({ open: 'reveal' });
  check('win32：UNC 路径（\\\\server\\share）被认作合法 patch 路径',
    harness.calls.some((row) => row[0].endsWith('/explorer.exe') && row[1] === `/select,${UNC_PATCH}`), describe(harness.calls));
  check('win32：UNC 的 reveal 不报「patch 路径未知」', outcome.body?.ok === true, JSON.stringify(outcome.body));
}

/* ================================================================ Toast 脚本结构 */

{
  // 通知脚本不在任何路由里，没法从外部触发；这里把源码里的两个函数摘出来求值，
  // 断言「多 AUMID 回退 / PowerShell 单引号转义 / UTF-16LE base64」没被改坏。
  const source = readFileSync(join(WORKSPACE, 'index.js'), 'utf8');
  const from = source.indexOf('function windowsToastAumids');
  const to = source.indexOf('/** AppleScript 字符串字面量');
  const build = new Function(`${source.slice(from, to)}; return { windowsToastAumids, windowsToastScript, powerShellEncoded };`);
  const saved = process.env.DSH_NOTIFY_AUMID;
  process.env.DSH_NOTIFY_AUMID = 'Acme.Custom';
  const { windowsToastAumids, windowsToastScript, powerShellEncoded } = build();
  const ids = windowsToastAumids();
  const script = windowsToastScript("标题 O'Brien", '正文 <&>');
  check('win32：Toast 依次试多个 AUMID（环境变量 → 应用名 → PowerShell 自带）',
    ids[0] === 'Acme.Custom' && ids.length >= 3 && ids.some((row) => row.includes('WindowsPowerShell')), ids.join(' | '));
  check('win32：Toast 脚本用换行拼接，没有 PowerShell 语法错误的「分号 + 花括号」',
    script.includes('\n') && !script.includes('{;'), JSON.stringify(script.slice(0, 32)));
  check('win32：正文单引号被翻倍转义', script.includes("O''Brien"), '');
  check('win32：-EncodedCommand 是 UTF-16LE base64，能解回原文',
    Buffer.from(powerShellEncoded(script), 'base64').toString('utf16le') === script, '');
  if (saved === undefined) delete process.env.DSH_NOTIFY_AUMID;
  else process.env.DSH_NOTIFY_AUMID = saved;
}

/* ---------------------------------------------------------------- 收尾 */

setPlatform(REAL_PLATFORM);
process.env.PATH = REAL_PATH;
const failed = results.filter((value) => value !== true).length;
console.log(`\n=== 平台分派：${results.length - failed}/${results.length} 通过 ===`);
process.exit(failed === 0 ? 0 : 1);
