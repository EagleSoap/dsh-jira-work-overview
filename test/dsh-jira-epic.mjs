// 离线：epic 从属关系的两个纯逻辑件（字段 id 解析 + 分组）。
//
// 真实站点踩到的坑（2026-11-20）：同一个站点既有 gh-epic-label（10011，恒空）又有
// gh-epic-link（10014，带键串），字段表里 label 排在前面；`find(schemas.includes(...))`
// 会选中恒空的 label，epic 视图永远只有「无 epic」一组。这里把它钉死。
import { copyFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const TMP = process.env.DSH_JIRA_TMP || (existsSync(join('/tmp', '.dsh_jira_env')) ? '/tmp' : tmpdir());
const HOST_COPY = join(TMP, 'dsh-jira-smoke3', 'index.js');
mkdirSync(join(TMP, 'dsh-jira-smoke3'), { recursive: true });
const WS = dirname(dirname(fileURLToPath(import.meta.url)));
copyFileSync(`${WS}/index.js`, HOST_COPY);

// 只抠两个纯函数：index.js 是 ESM 且依赖宿主模块，直接 import 在仓库外拿不到 @deepseek-ai/*。
const src = readFileSync(HOST_COPY, 'utf8');
const lines = src.split('\n');
/** 从 `startPrefix` 那行起按 `[`/`]` 与 `{`/`}` 的深度配平到收尾行（函数体里的 `}` 行不能当结尾）。 */
function block(startPrefix) {
  const start = lines.findIndex((line) => line.startsWith(startPrefix));
  if (start < 0) throw new Error(`找不到 ${startPrefix}`);
  let depth = 0;
  let opened = false;
  for (let i = start; i < lines.length; i += 1) {
    for (const ch of lines[i]) {
      if (ch === '{' || ch === '[') { depth += 1; opened = true; }
      else if (ch === '}' || ch === ']') depth -= 1;
    }
    if (opened && depth === 0) return lines.slice(start, i + 1).join('\n');
  }
  throw new Error(`找不到 ${startPrefix} 的结尾`);
}
const schemas = block('const EPIC_FIELD_SCHEMAS = [');
const resolveEpicField = block('async function resolveEpicField(');
const epicOf = block('function epicOf(');
const groupByEpic = block('function groupByEpic(');

const body = `return (async () => {\n${schemas}\n${resolveEpicField}\n${epicOf}\n${groupByEpic}\nreturn { resolveEpicField, epicOf, groupByEpic };\n})();`;
const mod = await new Function('t', body)((key) => (key === 'epic.none' ? '无 epic' : key));

let failed = 0;
const check = (cond, label, detail) => {
  if (!cond) failed += 1;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label} | ${detail}`);
};

/* ------------------------------------------- A：字段 id 解析优先级 */
const link = { id: 'customfield_10014', name: '长篇故事链接', schema: { custom: 'com.pyxis.greenhopper.jira:gh-epic-link', type: 'any' } };
const label = { id: 'customfield_10011', name: '长篇故事名称', schema: { custom: 'com.pyxis.greenhopper.jira:gh-epic-label', type: 'string' } };
const mkJira = (list) => ({ get: async () => list });

console.log('\nA 字段 id 解析');
for (const [list, want, name] of [
  [[label, link], 'customfield_10014', 'label 排在 link 前面时仍选 link（真实站点顺序）'],
  [[link, label], 'customfield_10014', 'link 在前时选 link'],
  [[label], 'customfield_10011', '只有 label 时退回 label'],
  [[{ id: 'customfield_9', name: 'Epic', schema: { type: 'any' } }], 'customfield_9', '没有已知 schema 时按「名字含 epic + 类型 any」兜底'],
  [[{ id: 'customfield_8', name: 'Epic', schema: { type: 'string' } }], '', '类型不是 any 的 Epic 字段不当 Epic Link（不误认）'],
  [[], '', '站点没有 epic 字段 → 空串（静默降级）'],
]) {
  const got = await mod.resolveEpicField(mkJira(list));
  check(got === want, name, JSON.stringify(got));
}
check(await mod.resolveEpicField({ get: async () => { throw new Error('boom'); } }) === '', '/field 请求失败 → 空串，不抛错', '空');
let calls = 0;
const cached = { get: async () => { calls += 1; return [link]; } };
await mod.resolveEpicField(cached);
await mod.resolveEpicField(cached);
check(calls === 1, '字段 id 只解析一次（实例缓存）', `${calls} 次请求`);

/* ------------------------------------------- B：epicOf 的三种字段形状 */
console.log('\nB epicOf');
check(JSON.stringify(mod.epicOf({ fields: { cf: { key: 'APP-1', summary: 'Epic 标题' } } }, 'cf'))
  === JSON.stringify({ key: 'APP-1', id: '', summary: 'Epic 标题' }), '对象形状（key + summary）', 'ok');
check(mod.epicOf({ fields: { cf: 'APP-9' } }, 'cf').key === 'APP-9', '纯键串形状（实测站点就是这种）', mod.epicOf({ fields: { cf: 'APP-9' } }, 'cf').key);
check(mod.epicOf({ fields: { cf: { id: '10001' } } }, 'cf').key === '', '只有 id 时不制造假键', '空 key');
check(mod.epicOf({}, 'cf').key === '' && mod.epicOf({ fields: { cf: null } }, 'cf').key === '' && mod.epicOf({ fields: {} }, '').key === '',
  '缺字段 / null / 没有字段 id 都退化成空（静默降级）', 'ok');
check(mod.epicOf({ fields: { cf: { key: 'APP-2', name: '按 name 兜底' } } }, 'cf').summary === '按 name 兜底', 'summary 缺失时退回 name', 'ok');

/* ------------------------------------------- C：分组 */
console.log('\nC groupByEpic');
const items = [
  { key: 'APP-1', project: 'APP', epicKey: 'APP-100', epicSummary: '跨项目 epic', category: 'new' },
  { key: 'OTH-2', project: 'OTH', epicKey: 'APP-100', epicSummary: '跨项目 epic', category: 'indeterminate' },
  { key: 'APP-3', project: 'APP', epicKey: 'APP-50', epicSummary: '', category: 'done' },
  { key: 'APP-4', project: 'APP', epicKey: '', epicSummary: '', category: 'new' },
];
const groups = mod.groupByEpic(items);
check(groups.length === 3, '三组：APP-100 / APP-50 / 无 epic', groups.map((g) => g.id).join(','));
check(groups.at(-1).id === null && groups.at(-1).name === '无 epic', '无 epic 永远垫底', groups.at(-1).name);
const cross = groups.find((g) => g.id === 'APP-100');
check(cross.projects.join(',') === 'APP,OTH', '跨项目组的 projects 去重且排序', cross.projects.join(','));
check(cross.counts.total === 2 && cross.counts.new === 1 && cross.counts.indeterminate === 1 && cross.counts.done === 0,
  'counts 按类别正确累加', JSON.stringify(cross.counts));
check(cross.keys.join(',') === 'APP-1,OTH-2', 'keys 保持入参顺序', cross.keys.join(','));
check(groups.find((g) => g.id === 'APP-50').name === 'APP-50', '没有 epic 摘要时组名退回键（link 字段不带标题）', groups.find((g) => g.id === 'APP-50').name);
check(mod.groupByEpic([]).length === 0, '空列表 → 空组', 'ok');
check(mod.groupByEpic([{ key: 'X-1', category: 'done' }]).length === 1, '完全缺 epicKey 字段也不崩', 'ok');

console.log(`\n=== epic 从属关系（字段解析 / 字段形状 / 分组）：${failed === 0 ? '全部通过' : `${failed} 项失败`} ===`);
process.exit(failed === 0 ? 0 : 1);
