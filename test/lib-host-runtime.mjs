/**
 * 套件共用：把仓库的 `index.js` 拷进临时目录，并把宿主自带的依赖
 * （`@deepseek-ai/schemastery` + 它的 `cosmokit`）备到它旁边的 `node_modules` 里。
 *
 * 为什么必须拷：host 半边 `import Schema from '@deepseek-ai/schemastery'`，那个包只活在
 * DSH 的 app.asar 里；asar 里的目录不能软链（Windows 上 junction 到 asar 也不行），
 * 只能整包复制出来。`DSH_INSTALL_DIR` 由 DSH 注入，指向 `<…>/dsh/node_modules/@deepseek-ai/dsh`，
 * 往上一级就是这个依赖树。
 *
 * 拿不到依赖时（干净机器、没装 DSH 的 Linux / Windows、CI）**不崩**：
 * 返回 `{ ok: false, reason }`，调用方打印 `SKIP: …` 并以 0 退出——套件在这类机器上是「跳过」，
 * 不是「失败」。
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

const HOST_DEPS = ['schemastery', 'cosmokit'];

function copyTree(from, to) {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from)) {
    const abs = join(from, entry);
    if (statSync(abs).isDirectory()) copyTree(abs, join(to, entry));
    else copyFileSync(abs, join(to, entry));
  }
}

/** 备好 `<dest>` 与它旁边的 node_modules；返回 `{ ok, reason? }`。 */
export function prepareHostCopy({ ws, dest }) {
  try {
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(join(ws, 'index.js'), dest);
  } catch (error) {
    return { ok: false, reason: `拷贝 index.js 失败：${error?.message ?? error}` };
  }
  const modules = join(dirname(dest), 'node_modules', '@deepseek-ai');
  const installDir = String(process.env.DSH_INSTALL_DIR || '').trim();
  if (!installDir && !existsSync(modules)) {
    return { ok: false, reason: '没有 DSH_INSTALL_DIR，也找不到已备好的 @deepseek-ai/schemastery' };
  }
  for (const name of HOST_DEPS) {
    const target = join(modules, name);
    if (existsSync(join(target, 'package.json'))) continue;
    // 锚点 `<root>/dsh/node_modules/@deepseek-ai/dsh` 往上一级就是依赖树目录。
    const root = join(installDir, '..', name);
    if (!installDir || !existsSync(root)) {
      return { ok: false, reason: `找不到宿主依赖 ${name}（DSH_INSTALL_DIR 未设置或该目录不存在）` };
    }
    try {
      copyTree(root, target);
    } catch (error) {
      return { ok: false, reason: `拷贝 ${name} 失败：${error?.message ?? error}` };
    }
  }
  return { ok: true };
}

/** 套件里紧接着 prepareHostCopy 用：拿不到依赖就 SKIP + 退出 0。 */
export function skipWhenUnavailable(result) {
  if (result?.ok) return false;
  console.log(`SKIP: ${result?.reason ?? '宿主依赖不可用'}`);
  process.exit(0);
}
