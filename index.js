/**
 * Jira work overview — 把当前 Jira 用户的 issue 及其实时工作流状态暴露为 DSH 工具。
 *
 * 这里只 import `@deepseek-ai/schemastery`：DSH 的启动装载层会给插件模块的裸
 * 说明符做重定位（dsh-app-boot 的 router.routeUrl / packageSearchPaths），
 * 因此 profile 里安装的 bundle 拿得到宿主自带的 `@deepseek-ai/*`。有了它才能
 * 声明 `Config`，从而拿到配置卡片与字段校验。
 *
 * 工具定义仍然手写成 ctx.tools.register 期望的 ToolDefinition 普通对象
 * （不 import defineTool），注册随 apply 的 fiber 卸载而注销。
 *
 * API token 不放配置：启动时若发现旧版明文 token，会自动搬进 DSH 凭据库。
 */

import Schema from '@deepseek-ai/schemastery';

const SEARCH_PATH = '/rest/api/3/search/jql';
// 只回一个 count 的检索端点：用来拿「该查询的准确总数」（不是当前页条数）。
const COUNT_PATH = '/rest/api/3/search/approximate-count';
// 站点优先级清单：**返回数组的下标就是 Jira 自己的优先级名次（0 = 最高级）**，面板据此上底色。
// 不用 priorityscheme 系列接口拿「每个项目自己的顺序」：它们要 Administer Jira 权限，
// 本机实测普通用户 GET /rest/api/3/priorityscheme 与 /{id}/priorities 都回空表、/{id} 回 405。
const PRIORITY_PATH = '/rest/api/3/priority';
// 优先级顺序是站点级配置、很少改：成功后缓存 6 小时；失败短退避 5 分钟，
// 免得一个可选能力在每次刷新时都多打一次注定失败的请求。
const PRIORITY_TTL_MS = 6 * 60 * 60 * 1000;
const PRIORITY_FAIL_TTL_MS = 5 * 60 * 1000;
// 项目 tab 的计数一次最多统计这么多个项目，超过就整体不显示（避免打一堆 count 请求）。
const MAX_COUNT_PROJECTS = 8;
// 翻页安全上限：Jira 单页最多 100 条，50 页 × 100 = 5000 条 = 一次查询最多能拉多少。
// （2026-11-18 从 6 抬到 12、再从 12 抬到 50：「取到完为止」的刹车就是这个页数，
//  再加上搜索时整轮翻页共用的 timeoutMs 总预算；达到它时仍然如实回 hasMore: true，不假装取完了。）
const MAX_PAGES = 50;
const PAGE_SIZE = 100;
const SAFETY_MAX = MAX_PAGES * PAGE_SIZE;
// 条数上限的唯一口径：命令 --limit、工具 limit、配置 maxResults、面板全部走这三个常量。
// **0 = 不限制**（一直翻页到 isLast / 没有 nextPageToken，只受上面 5000 条安全上限约束）。
const LIMIT_MIN = 10;
const LIMIT_MAX = 5000;
const LIMIT_DEFAULT = 0;
const DEFAULT_CREDENTIAL_KEY = 'JIRA_API_TOKEN';
const LIST_FIELDS = [
  'summary',
  'status',
  'issuetype',
  'priority',
  'assignee',
  'reporter',
  'duedate',
  'parent',
  'labels',
  'updated',
];

// statusCategory.key 才是稳定值；name 会跟随站点语言本地化。
const CATEGORY_ORDER = ['new', 'indeterminate', 'done'];
/** 状态分类文案的 key：statusCategory.key 是稳定的机器值，只有文案需要本地化。 */
const CATEGORY_KEYS = {
  new: 'category.new',
  indeterminate: 'category.indeterminate',
  done: 'category.done',
};

function categoryLabel(key) {
  const textKey = CATEGORY_KEYS[key];
  return textKey ? t(textKey) : String(key ?? '');
}

const SCOPE_JQL = {
  open: 'assignee = currentUser() AND statusCategory != Done ORDER BY status ASC, updated DESC',
  sprint: 'assignee = currentUser() AND sprint in openSprints() ORDER BY status ASC, updated DESC',
  all: 'assignee = currentUser() ORDER BY updated DESC',
};

const SCOPE_KEYS = {
  open: 'scope.open',
  sprint: 'scope.sprint',
  all: 'scope.all',
  jql: 'scope.jql',
};

function scopeLabel(scope) {
  return t(SCOPE_KEYS[scope] ?? 'scope.jql');
}

/**
 * 面板状态筛选菜单的选项来源：模块级缓存「这个进程见过到的状态名 → statusCategory.key」。
 * 只增不减：状态是站点级固定集合，不会因为某次查询没返回就消失，菜单才不会忽长忽短。
 * 排序稳定：先按 statusCategory（new → indeterminate → done），同类再按状态名；分类未知的排最后。
 */
const STATUS_SEEN = new Map();

function statusOptionsOf(items) {
  if (Array.isArray(items)) {
    for (const item of items) {
      const name = typeof item?.status === 'string' ? item.status.trim() : '';
      if (!name || STATUS_SEEN.has(name)) continue;
      STATUS_SEEN.set(name, typeof item?.category === 'string' ? item.category : '');
    }
  }
  return [...STATUS_SEEN.entries()]
    .map(([name, category]) => ({ name, category }))
    .sort((a, b) => {
      const rank = (row) => {
        const index = CATEGORY_ORDER.indexOf(row.category);
        return index < 0 ? CATEGORY_ORDER.length : index;
      };
      const diff = rank(a) - rank(b);
      if (diff !== 0) return diff;
      return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
    });
}

/**
 * 状态名清洗：先 trim、去掉双引号（JQL 里是 "…" 包裹的字符串字面量），
 * 再拒绝控制字符 \u0000-\u001f。非法时返回空串 —— 等价于「不筛选」。
 * 选「忽略」而不是报 400：面板永远发合法值，命令行手滑（例如 --status="Do
 * ne" 之类）不该让整次查询失败，跟 --limit 越界就退回默认值是同一口径。
 */
function sanitizeStatus(raw) {
  const text = typeof raw === 'string' ? raw.trim().replace(/"/g, '') : '';
  if (text === '' || /[\u0000-\u001f]/.test(text)) return '';
  return text;
}

/** 把状态筛选拼进 JQL（空串原样返回），ORDER BY 的坑交给 withJqlClause 处理。 */
function applyStatus(jql, status) {
  return status ? withJqlClause(jql, `status = "${status}"`) : jql;
}

const ISSUE_KEY = /^[A-Z][A-Z0-9_]*-\d+$/;
const COMMAND_NAME = 'jira';

/**
 * 可分类的 Jira 失败：`code` 是稳定的机器可读类型（client 的 FAILURES 表按它选提示文案），
 * `message` 仍是给人看的原文。命令结果只有 `{kind, text}` 两个槽（见 dsh-commands 的
 * CommandResult），所以 `--json` 的失败载荷把 code 放进 error 对象里，而不是靠匹配文案。
 * 类型只有这几种，新增一种要同时加 client 的 FAILURES 文案：
 *   no_credential / credential_unreadable / no_email / no_base_url / auth / http / network /
 *   not_json / unknown
 */
class JiraError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'JiraError';
    this.code = code;
  }
}

/** 没有 code 的异常（JSON.parse、第三方库、被 abort 等）一律归到 unknown。 */
function errorCodeOf(error) {
  const code = error && typeof error === 'object' ? error.code : undefined;
  return typeof code === 'string' && code ? code : 'unknown';
}

/** 401/403 是「这组邮箱 + 令牌不被接受」，和别的 HTTP 错误分开，界面提示也不一样。 */
function httpFailure(status, statusText, path, detail) {
  const code = status === 401 || status === 403 ? 'auth' : 'http';
  return new JiraError(code, t('err.http', { status, statusText, path, detail }));
}
/** Sprint 字段的 schema 标识（locale 无关）；找不到时退回 APP 站点的实际字段 id。 */
const SPRINT_FIELD_SCHEMA = 'com.pyxis.greenhopper.jira:gh-sprint';
const SPRINT_FIELD_FALLBACK = 'customfield_10020';

const DEFAULTS = {
  baseUrl: '',
  email: '',
  apiToken: '',
  credentialKey: DEFAULT_CREDENTIAL_KEY,
  projectKey: '',
  maxResults: LIMIT_DEFAULT,
  timeoutMs: 30000,
  watchEnabled: true,
  watchIntervalMs: 60000,
  notify: true,
  language: 'auto',
  // 上次用来打开 cordis.patch.yml 的编辑器 id（面板写、面板读，一般不用手改）。
  preferredEditor: '',
};

// --------------------------------------------------------- 文案字典 / i18n
//
// 只放插件自己的硬编码文案；**从 Jira 取回的数据一律原样展示**：issue 摘要、状态名、
// 父需求名、标签、sprint 名、账号名、错误详情里的 Jira 原文都不进这里。
// 语言只支持 zh / en，其它 tag 一律归一到 en（见 resolveLanguage）。

const TEXT = {
  zh: {
    // 状态分类与范围（statusCategory.key 是稳定的机器值，只有文案需要本地化）
    'category.new': '待办 / To Do',
    'category.indeterminate': '进行中 / In progress',
    'category.done': '已完成 / Done',
    'scope.open': '我的未完成 issue',
    'scope.sprint': '当前迭代里我的 issue',
    'scope.all': '我的全部 issue',
    'scope.jql': '我的匹配 issue',
    'common.unknown': '未知',
    'common.untitled': '(无标题)',
    'sep.list': '、',
    'sep.change': '；',
    // Config 各项 description（注册时取值）
    'config.baseUrl': 'Jira 站点根地址，例如 https://your-site.atlassian.net',
    'config.email': 'Basic 认证用的登录邮箱（与令牌绑定，可在插件配置页里改）',
    'config.credentialKey': 'DSH 凭据库里存放 API token 的键名',
    'config.projectKey': '项目键，仅用于展示与默认 JQL',
    'config.boardId': '看板 id（可选，目前只用于展示）',
    'config.maxResults': '每次拉取的条数；0 = 不限制（一直翻页到没有下一页为止，安全上限 5000 条 / 50 页 / 30s 超时），正数范围 10–5000，默认 0',
    'config.timeoutMs': '单次 Jira 请求超时（毫秒）',
    'config.watchEnabled': '后台定时检查有没有新指派 / 状态变化，并在本机弹系统通知（macOS 走 osascript、Windows 走 PowerShell Toast）',
    'config.watchIntervalMs': '后台检查间隔（毫秒），最小 15000，面板「配置」里可改',
    'config.notify': '发现新指派 / 状态变化时弹系统通知（按平台自动选择）',
    'config.language': '界面与工具输出用哪种语言：auto（跟随 DSH / 系统） / zh / en',
    'config.preferredEditor': '上次用来打开配置文件的编辑器 id（由面板写入，一般不用手改）',
    'config.apiToken': '旧版明文 token，首次加载会自动迁移进凭据库；迁移成功后请清空此项',
    // 注册期提示（通道没注册成功这类非致命问题）
    'note.noCommands': '未注册 /{name} 命令：这个 profile 没有 commands 服务。',
    'note.noCommandsError': '未注册 /{name} 命令：{message}',
    'note.noWatchRoute': '未注册面板角标通道（{path}）：这个 profile 没有 connection.fetch 服务；系统通知与后台监视不受影响。',
    'note.noWatchRouteError': '未注册面板角标通道（{path}）：{message}',
    'note.noTransitionRoute': '未注册状态流转通道（{path}）：{message}',
    'note.noCredentialRoute': '未注册令牌配置通道（{path}）：这个 profile 没有 connection.fetch 服务；仍可直接改 DSH 凭据库里的 {key}。',
    'note.noCredentialRouteError': '未注册令牌配置通道（{path}）：{message}',
    'note.noSettingsRoute': '未注册配置写入通道（{path}）：这个 profile 没有 connection.fetch 服务；仍可直接改 profile 的 cordis.patch.yml。',
    'note.noSettingsRouteError': '未注册配置写入通道（{path}）：{message}',
    'note.credUnavailable': '凭据服务不可用，{key} 仍从配置里的明文 token 读取。',
    'note.tokenMigrated': '已把配置里的明文 token 迁移进 DSH 凭据库（{key}），可以从插件配置里删除 apiToken 了。',
    'note.tokenMigrateUnreadable': '凭据库写入 {key} 后读不回来，仍从配置里的明文 token 读取。',
    'note.tokenMigrateFailed': '把 token 迁移进凭据库失败（{message}），仍从配置读取。',
    'note.openChooseFailed': '打开「选择应用」对话框失败：{message}',
    // 凭据来源
    'token.source.unread': '未读取',
    'token.source.credential': 'DSH 凭据库 {key}',
    'token.source.env': '环境变量 {key}',
    'token.source.envNotStore': '环境变量 {key}（不是凭据库）',
    'token.source.config': '插件配置 apiToken（明文，建议迁移到凭据库）',
    'token.source.configAlt': '插件配置 apiToken（明文，建议改存凭据库）',
    'token.source.missing': '凭据库 {key} 里没有值',
    'token.source.readFailed': '读凭据库失败：{message}',
    // 错误与提示
    'err.noCredential': 'Jira 凭据缺失：请把 {key} 写进 DSH 凭据库、设为环境变量，或填进插件配置的 apiToken。',
    'err.credentialUnreadable': '读不出 DSH 凭据库里的 {key}：{message}',
    'err.noBaseUrl': '还没有配置 Jira 站点地址：打开面板标题右侧的「配置」填上 baseUrl（例如 https://your-site.atlassian.net），或在 profile 的 cordis.patch.yml 那一行里加 baseUrl。',
    'err.noEmail': 'Jira 配置缺少 email：Basic 认证需要登录邮箱。',
    'err.network': '连不上 {baseUrl}（{path}）：{cause}',
    'err.http': 'Jira {status} {statusText}（{path}）：{detail}',
    'err.notJson': 'Jira 返回了非 JSON 响应（{path}）',
    'err.noDetail': '（无详情）',
    'err.invalidKey': '无效的 issue key：「{key}」，应形如 APP-3489。',
    'err.missingTransitionId': '缺少 transitionId',
    'err.emailNotSet': '（未设置：Basic 认证需要邮箱）',
    'err.noUnset': '这个 profile 的凭据服务不支持删除凭据。',
    'err.needEmail': 'Basic 认证需要登录邮箱：请填上账号邮箱。',
    'err.badEmail': '「{email}」不像一个邮箱地址。',
    'err.tokenTooShort': '这不像一个 API token（长度过短）。',
    'err.noToken': '还没有令牌：请先填一个 Jira API token。',
    'err.credWriteUnavailable': '这个 profile 的凭据服务不可用，无法写入凭据库。',
    'err.rejected': '这个邮箱 + 令牌的组合 Jira 不认（HTTP {status}）：{message}',
    'err.noWritableField': '没有可写入的字段。',
    'err.noSettingsService': '这个 profile 没有 settings 服务（或它没有挂 config-editor），配置无法持久化，只在本次运行内生效。',
    'err.openModeInvalid': '不支持的打开方式：{mode}（只支持 default / choose / reveal / app / custom）。',
    'err.patchPathUnknown': '这个 profile 的 cordis.patch.yml 路径不可用，无法打开。',
    'err.openFailed': '打开失败：{path}（{message}）',
    'err.editorUnknown': '未知的编辑器：{app}',
    'err.customAppEmpty': '请填写应用名或完整路径。',
    'err.customAppInvalid': '应用名或路径不能包含换行或控制字符。',
    'err.chooseUnsupported': '当前平台没有系统级的「选择打开方式」，请手动打开文件。',
    'verify.skipped': '没有邮箱或令牌可验证',
    // 命令
    'command.description': '列出我的 Jira 迭代内容与完成状态（命令面直接渲染，不产生模型消息）',
    'command.hint': '[--json] [--limit=<n>|0] [--lang=<tag>] [open|sprint|all | <issue key> | <JQL>]',
    'command.failed': 'Jira 读取失败：{message}',
    // 工具描述与参数（注册时取值，DSH 不会随语言切换实时更新）
    'tool.myWork.description': '读取指派给我的 Jira issue 及其当前工作流状态（跨项目，按 issue key 前缀区分）。默认只列未完成项，用来了解我在迭代里还要做什么、哪些已完成但还在等测试；scope 可切换到当前活跃迭代或全部 issue。',
    'tool.myWork.scope': 'open=未完成（默认）；sprint=当前活跃迭代内我的 issue；all=我的全部 issue',
    'tool.myWork.jql': '自定义 JQL；给出时覆盖 scope',
    'tool.myWork.limit': '返回条数；0 = 不限制（默认 0，一直翻页到没有下一页为止，安全上限 5000 条），正数范围 10–5000',
    'tool.myWork.status': '只看某个工作流状态（状态名，例如 "IN QA" / "已完成"）；省略或空串 = 全部；非法值忽略',
    'tool.issue.description': '读取单条 Jira issue 的完整内容：核心字段、描述（ADF 转为纯文本）以及可选的评论。用来了解某个需求具体要做什么、涉及哪些页面和验收条件。',
    'tool.issue.key': 'issue key，例如 APP-3489',
    'tool.issue.comments': '是否附带评论，默认 false',
    'tool.issue.commentLimit': '最多返回多少条评论，默认 10，上限 50',
    'tool.transition.description': '查看某个 issue 当前可用的状态流转（Jira 只允许工作流定义的流转，不是随便写状态名），并在显式 apply=true 时把 issue 流转到新状态。默认只预览、不写入。',
    'tool.transition.to': '目标状态名（如 "IN QA" / "完成"）或流转 id（如 "81"）；省略则只列出可用流转',
    'tool.transition.apply': 'true 才真正执行流转；默认 false 只预览要做的改动',
    // 状态流转输出
    'transition.header': '# {key} 状态流转',
    'transition.current': '- 当前状态：{status}',
    'transition.available': '- 可用流转（{count} 项）：',
    'transition.row': '  - `{id}` → {to}{required}',
    'transition.rowRequired': '（需要字段：{fields}）',
    'transition.hintApply': '要改状态：再调用一次，带上 `to`（目标状态名或流转 id）和 `apply: true`。',
    'transition.notAvailable': '「{wanted}」不是 {key} 当前可用的流转。可用的是：{list}',
    'transition.willApply': '- 将执行：`{id}` {name} → **{to}**',
    'transition.needsFields': '- ⚠️ 这个流转需要填字段：{fields}',
    'transition.previewOnly': '这是预览，**没有写入**。确认无误后再调用一次并加 `apply: true`。',
    'transition.updated': '# {key} 状态已更新',
    'transition.updatedLine': '- {from} → **{to}**（流转 `{id}` {name}）',
    // 迭代（看板）
    'sprint.backlog': '无迭代',
    'sprint.none': '看板 {boardId} 上没有 active 迭代。',
    'sprint.unnamed': '(未命名)',
    'sprint.late': '结束日已过 {days} 天，但仍是 active',
    'sprint.inProgress': '进行中',
    'sprint.readFailed': '读取看板 {boardId} 的 active 迭代失败：{message}',
    // 文本列表
    'list.header': '## {scope} — {count} 条',
    'list.meta': '- Jira：{baseUrl}　项目：{project}　账号：{account}',
    'list.accountMissing': '(未配置 email)',
    'list.credentialSource': '- 凭据来源：{source}',
    'watch.checked': '已检查 {count} 次',
    'watch.notRun': '还没跑第一轮',
    'watch.pending': '，未读变化 {count} 项',
    'watch.noPending': '，暂无未读变化',
    'watch.failures': '；最近 {count} 次失败：{message}',
    'watch.line': '- 后台监视：每 {seconds}s 检查一次（{seen}）{pending}{failures}',
    'watch.disabledLine': '- 后台监视：已在配置里关闭（watchEnabled: false）',
    'list.jql': '- JQL：`{jql}`',
    'list.note': '- 提示：{note}',
    'list.empty': '没有匹配的 issue。',
    'list.statusCounts': '**状态分布**：{counts}',
    'list.hasMore': '**还有更多**：已经取到上限 {limit} 条（0 = 不限制时的安全上限是 5000 条 / 50 页 / 30s 超时），想看更多请收窄 JQL 或加 `--status=`',
    'list.overdue': '**已逾期**：{count} 项（{keys}）',
    'list.projectCount': '{names}（{count} 个项目）',
    // issue 一行 / 详情
    'issue.parent': '父 {key}',
    'issue.due': '到期 {date}{overdue}',
    'issue.overdue': '（已逾期）',
    'issue.updated': '更新 {date}',
    'issue.meta.type': '类型 {value}',
    'issue.meta.status': '状态 {value}（{category}）',
    'issue.meta.priority': '优先级 {value}',
    'issue.meta.assignee': '经办人 {value}',
    'issue.meta.reporter': '报告人 {value}',
    'issue.meta.parent': '父需求 {key}',
    'issue.meta.components': '模块 {value}',
    'issue.meta.labels': '标签 {value}',
    'issue.meta.due': '到期 {value}',
    'issue.meta.created': '创建 {value}',
    'issue.meta.updated': '更新 {value}',
    'issue.link': '链接：{url}',
    'issue.descriptionHeader': '## 描述',
    'issue.noDescription': '（无描述）',
    'issue.commentsHeader': '## 评论（共 {total} 条，显示最近 {shown} 条）',
    'issue.noComments': '（无评论）',
    'issue.emptyComment': '（空）',
    'issue.attachment': '[附件]',
    // 变化描述与系统通知
    'change.new': '{key} {summary}（{status}）',
    'change.status': '{key} {from} → {to}',
    'change.closed': '{key} 离开了未完成列表',
    'notify.newAssignTitle': 'Jira：有新指派给我的工作',
    'notify.changesTitle': 'Jira：{count} 项变化',
    // 打开 cordis.patch.yml
    'patch.choosePrompt': '选择用来打开 cordis.patch.yml 的应用',
  },
  en: {
    'category.new': 'To Do',
    'category.indeterminate': 'In progress',
    'category.done': 'Done',
    'scope.open': 'My open issues',
    'scope.sprint': 'My issues in the active sprint',
    'scope.all': 'All my issues',
    'scope.jql': 'My matching issues',
    'common.unknown': 'Unknown',
    'common.untitled': '(no summary)',
    'sep.list': ', ',
    'sep.change': '; ',
    'config.baseUrl': 'Jira site root URL, for example https://your-site.atlassian.net',
    'config.email': 'Login email for Basic auth (paired with the token; editable on the plugin config page)',
    'config.credentialKey': 'Key name of the API token in the DSH credential store',
    'config.projectKey': 'Project key, used only for display and the default JQL',
    'config.boardId': 'Board id (optional; currently display only)',
    'config.maxResults': 'Items fetched per query; 0 = unlimited (pages until there is no next page; safety cap 5000 items / 50 pages / 30s timeout), a positive value ranges 10-5000, default 0',
    'config.timeoutMs': 'Timeout for a single Jira request (ms)',
    'config.watchEnabled': 'Poll in the background for new assignments / status changes and raise a desktop notification (osascript on macOS, PowerShell Toast on Windows)',
    'config.watchIntervalMs': 'Background check interval (ms), minimum 15000, editable in the panel config',
    'config.notify': 'Raise a desktop notification on new assignments / status changes (platform-specific)',
    'config.language': 'Language for the UI and tool output: auto (follow DSH / system) / zh / en',
    'config.preferredEditor': 'Id of the editor most recently used to open the config file (written by the panel; you normally should not edit this)',
    'config.apiToken': 'Legacy plaintext token; migrated into the credential store on first load. Clear this field once the migration succeeds.',
    'note.noCommands': 'Did not register the /{name} command: this profile has no commands service.',
    'note.noCommandsError': 'Did not register the /{name} command: {message}',
    'note.noWatchRoute': 'Did not register the panel badge channel ({path}): this profile has no connection.fetch service; desktop notifications and background watching are unaffected.',
    'note.noWatchRouteError': 'Did not register the panel badge channel ({path}): {message}',
    'note.noTransitionRoute': 'Did not register the transition channel ({path}): {message}',
    'note.noCredentialRoute': 'Did not register the token config channel ({path}): this profile has no connection.fetch service; you can still edit {key} directly in the DSH credential store.',
    'note.noCredentialRouteError': 'Did not register the token config channel ({path}): {message}',
    'note.noSettingsRoute': 'Did not register the settings write channel ({path}): this profile has no connection.fetch service; you can still edit the profile cordis.patch.yml directly.',
    'note.noSettingsRouteError': 'Did not register the settings write channel ({path}): {message}',
    'note.credUnavailable': 'Credential service unavailable; {key} is still read from the plaintext token in config.',
    'note.tokenMigrated': 'Migrated the plaintext token from config into the DSH credential store ({key}); you can remove apiToken from the plugin config now.',
    'note.tokenMigrateUnreadable': 'Wrote {key} into the credential store but could not read it back; still reading the plaintext token from config.',
    'note.tokenMigrateFailed': 'Failed to migrate the token into the credential store ({message}); still reading from config.',
    'note.openChooseFailed': 'Failed to open the application chooser: {message}',
    'token.source.unread': 'not read yet',
    'token.source.credential': 'DSH credential store {key}',
    'token.source.env': 'environment variable {key}',
    'token.source.envNotStore': 'environment variable {key} (not the credential store)',
    'token.source.config': 'plugin config apiToken (plaintext; migrating into the credential store is recommended)',
    'token.source.configAlt': 'plugin config apiToken (plaintext; store it in the credential store instead)',
    'token.source.missing': 'no value in credential store {key}',
    'token.source.readFailed': 'Failed to read the credential store: {message}',
    'err.noCredential': 'Missing Jira credential: put {key} into the DSH credential store, set it as an environment variable, or fill apiToken in the plugin config.',
    'err.credentialUnreadable': 'Could not read {key} from the DSH credential store: {message}',
    'err.noBaseUrl': 'No Jira site URL yet: open the "Configure" dialog in the panel header and set baseUrl (for example https://your-site.atlassian.net), or add baseUrl to this profile\'s cordis.patch.yml row.',
    'err.noEmail': 'Missing email in the Jira config: Basic auth requires a login email.',
    'err.network': 'Cannot reach {baseUrl} ({path}): {cause}',
    'err.http': 'Jira {status} {statusText} ({path}): {detail}',
    'err.notJson': 'Jira returned a non-JSON response ({path})',
    'err.noDetail': '(no detail)',
    'err.invalidKey': 'Invalid issue key: "{key}"; expected a key such as APP-3489.',
    'err.missingTransitionId': 'Missing transitionId',
    'err.emailNotSet': '(not set: Basic auth requires an email)',
    'err.noUnset': 'The credential service in this profile does not support deleting credentials.',
    'err.needEmail': 'Basic auth requires a login email: fill in the account email.',
    'err.badEmail': '"{email}" does not look like an email address.',
    'err.tokenTooShort': 'This does not look like an API token (too short).',
    'err.noToken': 'No token yet: fill in a Jira API token first.',
    'err.credWriteUnavailable': 'The credential service in this profile is unavailable; cannot write to the credential store.',
    'err.rejected': 'Jira rejected this email + token combination (HTTP {status}): {message}',
    'err.noWritableField': 'No writable field.',
    'err.noSettingsService': 'This profile has no settings service (or it has no config-editor attached); the config cannot be persisted and applies only to this run.',
    'err.openModeInvalid': 'Unsupported open mode: {mode} (only default / choose / reveal / app / custom are supported).',
    'err.patchPathUnknown': 'The cordis.patch.yml path of this profile is unavailable, so it cannot be opened.',
    'err.openFailed': 'Failed to open {path} ({message})',
    'err.editorUnknown': 'Unknown editor: {app}',
    'err.customAppEmpty': 'Enter an application name or full path.',
    'err.customAppInvalid': 'The application name or path must not contain newlines or control characters.',
    'err.chooseUnsupported': 'This platform has no system app chooser; open the file manually.',
    'verify.skipped': 'nothing to verify without an email and a token',
    'command.description': 'List my Jira sprint contents and completion status (rendered in the command surface, no model message)',
    'command.hint': '[--json] [--limit=<n>|0] [--lang=<tag>] [open|sprint|all | <issue key> | <JQL>]',
    'command.failed': 'Jira read failed: {message}',
    'tool.myWork.description': 'Read the Jira issues assigned to me together with their current workflow status (across projects, distinguished by issue key prefix). By default only open items are listed, to answer what is left in the sprint and what is done but still awaiting test; scope can switch to the active sprint or all issues.',
    'tool.myWork.scope': 'open=open items (default); sprint=my issues in the active sprint; all=all my issues',
    'tool.myWork.jql': 'Custom JQL; overrides scope when given',
    'tool.myWork.limit': 'Number of issues to return; 0 = unlimited (default 0, pages until there is no next page, safety cap 5000 items), a positive value ranges 10-5000',
    'tool.myWork.status': 'Only one workflow status (status name, for example "IN QA"); empty means all; an invalid value is ignored',
    'tool.issue.description': 'Read the full content of a single Jira issue: core fields, description (ADF converted to plain text) and optional comments. Use it to learn what a requirement asks for, which pages it touches and its acceptance criteria.',
    'tool.issue.key': 'issue key, for example APP-3489',
    'tool.issue.comments': 'Whether to include comments, default false',
    'tool.issue.commentLimit': 'Maximum number of comments to return, default 10, cap 50',
    'tool.transition.description': 'Show the transitions currently available for an issue (Jira only allows transitions defined by the workflow, not arbitrary status names), and move the issue to a new status when apply=true is passed explicitly. Preview only by default, no writes.',
    'tool.transition.to': 'Target status name (for example "IN QA" / "Done") or transition id (for example "81"); omit it to just list the available transitions',
    'tool.transition.apply': 'Only true actually performs the transition; default false previews the change',
    'transition.header': '# {key} transitions',
    'transition.current': '- Current status: {status}',
    'transition.available': '- Available transitions ({count}):',
    'transition.row': '  - `{id}` → {to}{required}',
    'transition.rowRequired': ' (requires fields: {fields})',
    'transition.hintApply': 'To change status: call again with `to` (target status name or transition id) and `apply: true`.',
    'transition.notAvailable': '"{wanted}" is not an available transition for {key}. Available: {list}',
    'transition.willApply': '- Will apply: `{id}` {name} → **{to}**',
    'transition.needsFields': '- ⚠️ This transition requires fields: {fields}',
    'transition.previewOnly': 'This is a preview, **nothing was written**. Call again with `apply: true` once it looks right.',
    'transition.updated': '# {key} status updated',
    'transition.updatedLine': '- {from} → **{to}** (transition `{id}` {name})',
    'sprint.backlog': 'No sprint',
    'sprint.none': 'Board {boardId} has no active sprint.',
    'sprint.unnamed': '(unnamed)',
    'sprint.late': 'End date passed {days} days ago but it is still active',
    'sprint.inProgress': 'In progress',
    'sprint.readFailed': 'Failed to read the active sprint of board {boardId}: {message}',
    'list.header': '## {scope} — {count} items',
    'list.meta': '- Jira: {baseUrl} · Project: {project} · Account: {account}',
    'list.accountMissing': '(email not configured)',
    'list.credentialSource': '- Credential source: {source}',
    'watch.checked': 'checked {count} times',
    'watch.notRun': 'first round not run yet',
    'watch.pending': ', {count} unread changes',
    'watch.noPending': ', no unread changes',
    'watch.failures': '; last {count} failures: {message}',
    'watch.line': '- Background watch: checking every {seconds}s ({seen}){pending}{failures}',
    'watch.disabledLine': '- Background watch: disabled in config (watchEnabled: false)',
    'list.jql': '- JQL: `{jql}`',
    'list.note': '- Note: {note}',
    'list.empty': 'No matching issues.',
    'list.statusCounts': '**Status distribution**: {counts}',
    'list.hasMore': '**More available**: hit the cap of {limit} items (with 0 = unlimited the safety cap is 5000 items / 50 pages / 30s timeout); narrow the JQL or add `--status=` to see more',
    'list.overdue': '**Overdue**: {count} items ({keys})',
    'list.projectCount': '{names} ({count} projects)',
    'issue.parent': 'parent {key}',
    'issue.due': 'due {date}{overdue}',
    'issue.overdue': ' (overdue)',
    'issue.updated': 'updated {date}',
    'issue.meta.type': 'Type {value}',
    'issue.meta.status': 'Status {value} ({category})',
    'issue.meta.priority': 'Priority {value}',
    'issue.meta.assignee': 'Assignee {value}',
    'issue.meta.reporter': 'Reporter {value}',
    'issue.meta.parent': 'Parent {key}',
    'issue.meta.components': 'Components {value}',
    'issue.meta.labels': 'Labels {value}',
    'issue.meta.due': 'Due {value}',
    'issue.meta.created': 'Created {value}',
    'issue.meta.updated': 'Updated {value}',
    'issue.link': 'Link: {url}',
    'issue.descriptionHeader': '## Description',
    'issue.noDescription': '(no description)',
    'issue.commentsHeader': '## Comments ({total} total, showing the latest {shown})',
    'issue.noComments': '(no comments)',
    'issue.emptyComment': '(empty)',
    'issue.attachment': '[attachment]',
    'change.new': '{key} {summary} ({status})',
    'change.status': '{key} {from} → {to}',
    'change.closed': '{key} left the open list',
    'notify.newAssignTitle': 'Jira: new work assigned to me',
    'notify.changesTitle': 'Jira: {count} changes',
    'patch.choosePrompt': 'Choose an application to open cordis.patch.yml',
  },
};

/** 当前语言（zh / en）。apply 里第一次 syncLang 之后就是正确的值。 */
let LANG = 'zh';
/** 客户端（面板）最后一次上报的语言。DSH 没设语言偏好时用它当界面的实际语言，见 resolveLanguage。 */
let REPORTED_LANG = '';

/** 取文案：{name} 占位替换；缺 key 先回落 en、再回落 key 本身，绝不抛错。 */
function t(key, params) {
  let value = TEXT[LANG]?.[key];
  if (typeof value !== 'string') value = TEXT.en?.[key];
  if (typeof value !== 'string') return String(key);
  if (!params) return value;
  return value.replace(/\{(\w+)\}/g, (match, name) => (
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
  ));
}

/** 任何 tag（zh-CN、zh-Hans、en-GB…）都归一化：以 zh 开头 → zh，否则 en。 */
function normalizeLangTag(tag) {
  const value = String(tag ?? '').trim().toLowerCase();
  if (!value) return '';
  return value.startsWith('zh') ? 'zh' : 'en';
}

/** 语言判定，优先级从高到低：env 强制 → 操作覆盖 → 配置 → DSH locale → 系统环境 → ICU → en。 */
function resolveLanguage(ctx, settings, override) {
  const forced = process.env.DSH_JIRA_LANG;
  if (typeof forced === 'string' && forced.trim()) return normalizeLangTag(forced);

  if (typeof override === 'string' && override.trim()) return normalizeLangTag(override);

  const configured = String(liveSetting(settings, 'language', DEFAULTS.language) ?? '').trim().toLowerCase();
  if (configured === 'zh' || configured === 'en') return configured;

  try {
    const described = safeService(ctx, 'settings')?.describe?.();
    const entry = Array.isArray(described) ? described.find((row) => row?.ns === 'locale') : undefined;
    const value = unwrapValue(entry?.value);
    const preference = value && typeof value === 'object' ? value.preference : value;
    if (typeof preference === 'string' && preference.trim()) return normalizeLangTag(preference);
  } catch {
    /* 拿不到宿主语言设置就继续往下走 */
  }

  // 面板每次请求都带 ?lang=，那是浏览器按 navigator.languages 解析出的界面语言。
  // macOS 上 LANG=C.UTF-8 会被归一成 en，若不用这个信号，工具输出会跟界面语言不一致。
  if (REPORTED_LANG) return REPORTED_LANG;

  const fromSystem = process.env.LANGUAGE || process.env.LC_ALL || process.env.LANG;
  if (typeof fromSystem === 'string' && fromSystem.trim()) return normalizeLangTag(fromSystem);

  try {
    const locale = Intl.DateTimeFormat().resolvedOptions().locale;
    if (typeof locale === 'string' && locale.trim()) return normalizeLangTag(locale);
  } catch {
    /* ICU 不可用就落到兜底 */
  }

  return 'en';
}

/** 记下客户端上报的语言标签（只认非空字符串；空值不动，避免 GET 不带 lang 时把手动覆盖抹掉）。 */
function rememberReportedLang(tag) {
  if (typeof tag !== 'string' || !tag.trim()) return;
  REPORTED_LANG = normalizeLangTag(tag);
}

/** 同步解析并写入模块级 LANG；解析失败保持上一次的值，不抛。 */
function syncLang(ctx, settings, override) {
  try {
    LANG = resolveLanguage(ctx, settings, override);
  } catch {
    /* 语言解析失败不是致命错误 */
  }
  return LANG;
}

/** 从命令原始输入里取 --lang=<tag>（命令面用；不进 JQL）。 */
function langOverrideFromTokens(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  const token = raw.trim().split(/\s+/).find((part) => part.startsWith('--lang='));
  if (!token) return undefined;
  return token.slice('--lang='.length).trim() || undefined;
}

export const inject = ['tools'];

/**
 * 插件配置。加密钥不放这里：token 存在 DSH 凭据库里，由 credentialKey 指向。
 * `apiToken` 只为兼容旧版明文配置保留，首次加载后会迁移走。
 */
export const Config = Schema.object({
  baseUrl: Schema.string()
    .default(DEFAULTS.baseUrl)
    .description(t('config.baseUrl')),
  email: Schema.string().default('').volatile().description(t('config.email')),
  credentialKey: Schema.string()
    .default(DEFAULT_CREDENTIAL_KEY)
    .description(t('config.credentialKey')),
  projectKey: Schema.string().default('').description(t('config.projectKey')),
  boardId: Schema.number().description(t('config.boardId')),
  maxResults: Schema.number().default(LIMIT_DEFAULT).volatile()
    .description(t('config.maxResults')),
  timeoutMs: Schema.number().default(30000).description(t('config.timeoutMs')),
  // 下面三个字段是「运行时可改」的：标了 .volatile() 之后，Host 的 settings 服务才能把它们
  // 写进当前 profile 的 cordis patch，并且改完由 Loader 直接提交到运行中的引用（不重装插件）。
  // 面板「配置」弹窗里的后台监视表单写的就是这三项。
  watchEnabled: Schema.boolean()
    .default(true)
    .volatile()
    .description(t('config.watchEnabled')),
  watchIntervalMs: Schema.number()
    .default(60000)
    .volatile()
    .description(t('config.watchIntervalMs')),
  notify: Schema.boolean()
    .default(true)
    .volatile()
    .description(t('config.notify')),
  language: Schema.string()
    .default('auto')
    .volatile()
    .description(t('config.language')),
  // 面板「用某个编辑器打开配置文件」时把 id 记在这里，下次把那个按钮标成「上次用过」。
  preferredEditor: Schema.string()
    .default('')
    .volatile()
    .description(t('config.preferredEditor')),
  apiToken: Schema.string()
    .default('')
    .description(t('config.apiToken')),
});

export function apply(ctx, config) {
  const settings = normalizeConfig(config);
  // 注册前先把语言定下来：Config 文案与下面这些启动期提示取的都是此刻的 LANG。
  syncLang(ctx, settings);
  const jira = createJira(ctx, settings);

  // 后台监视：本机定时轮询 + 变化时的系统通知；面板角标通过 /api 之下的精确 Fetch 路由读同一份状态。
  jira.watch = startWatcher(ctx, jira, settings);
  registerWatchRoute(ctx, jira, jira.watch);
  // 面板里「改状态」用的通道（GET 列可用流转 / POST 执行流转）。
  registerTransitionRoute(ctx, jira);
  // 插件配置页里的令牌填写通道（GET 打码状态 / POST 保存或清除），仍写同一个凭据库键。
  registerCredentialRoute(ctx, jira, settings);
  // 面板「配置」里的后台监视表单（轮询开关 / 间隔 / 通知）走宿主 settings 服务写 volatile 字段。
  registerSettingsRoute(ctx, jira, settings);

  ctx.tools.register(myWorkTool(jira, settings));
  ctx.tools.register(issueTool(jira, settings));
  ctx.tools.register(transitionTool(jira, settings));
  registerCommand(ctx, jira);

  // 旧版把 token 明文写在 cordis.patch.yml 的 config 里。首次加载时搬进凭据库，
  // 之后明文就可以从配置里删掉（凭据库优先于环境变量和 config）。
  if (settings.apiToken) void migrateLegacyToken(ctx, jira, settings);
}

/**
 * 同一个操作只实现一次：工具给 agent 用，斜杠命令给人在命令面里直接用
 * （命令结果不进入模型消息）。这里用 ctx.get 而不是 inject，避免在没有
 * 命令表面的 profile 里让整个插件停在 pending。
 */
function registerCommand(ctx, jira) {
  const commands = typeof ctx?.get === 'function' ? ctx.get('commands') : undefined;
  if (!commands || typeof commands.register !== 'function') {
    jira.notes.push(t('note.noCommands', { name: COMMAND_NAME }));
    return;
  }
  try {
    commands.register({
      name: COMMAND_NAME,
      description: t('command.description'),
      input: { hint: t('command.hint') },
      async handler(invocation) {
        const raw = typeof invocation?.rawInput === 'string' ? invocation.rawInput.trim() : '';
        const signal = invocation?.signal;
        // 命令行里的 --lang= 是「这一次操作」的覆盖，优先于 Config。
        jira.useLang(langOverrideFromTokens(raw));
        try {
          return { kind: 'success', text: await runCommand(jira, raw, signal) };
        } catch (error) {
          return { kind: 'error', text: t('command.failed', { message: error?.message ?? error }) };
        }
      },
    });
  } catch (error) {
    // 同层重名注册会抛错；命令只是附加入口，绝不能因此让整个插件（连同两个工具）激活失败。
    jira.notes.push(t('note.noCommandsError', { name: COMMAND_NAME, message: error?.message ?? error }));
  }
}

async function runCommand(jira, raw, signal) {
  const tokens = typeof raw === 'string' && raw.trim() ? raw.trim().split(/\s+/) : [];
  // `--json` 是给 client 面板用的：同一次查询，换成结构化输出让界面自己排版。
  const json = tokens.includes('--json');
  const limitToken = tokens.find((token) => token.startsWith('--limit='));
  const limit = limitToken ? normalizeLimit(limitToken.slice('--limit='.length), limitOf(jira.settings)) : limitOf(jira.settings);
  // 逐 token 收集剩余参数（= scope 词或自定义 JQL），同时摘掉三个开关：
  //   --limit=… / --lang=… 只影响这一次输出；
  //   `--status=<状态名>` = 只看一个工作流状态（面板筛选菜单发的就是它），非法值忽略（见 sanitizeStatus）。
  // 状态名可能带空格（例如 `IN QA`），会被 split 切开，所以从 `--status=` 起一路吃到下一个 `--` 开关为止。
  const restTokens = [];
  let status = '';
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === '--json' || token.startsWith('--limit=') || token.startsWith('--lang=')) continue;
    if (token.startsWith('--status=')) {
      const parts = [token.slice('--status='.length)];
      while (i + 1 < tokens.length && !tokens[i + 1].startsWith('--')) {
        i += 1;
        parts.push(tokens[i]);
      }
      status = sanitizeStatus(parts.join(' '));
      continue;
    }
    restTokens.push(token);
  }
  const rest = restTokens.join(' ').trim();
  const { jql, scope } = resolveQuery(
    Object.prototype.hasOwnProperty.call(SCOPE_JQL, rest) ? rest : '',
    rest && !SCOPE_JQL[rest] ? rest : '',
  );

  try {
    return await runQuery(jira, { json, limit, rest, status, jql, scope, signal });
  } catch (error) {
    // 面板走 --json：失败也做成结构化载荷（ok:false + error.code），界面才能按类型给提示，
    // 而不是把一整句报错糊在列表位置。命令行文本输出保持原样抛出（那条命令面本来就该看到错误）。
    if (!json) throw error;
    return JSON.stringify(buildWorkListErrorJson(jira, error, { jql, scope, status, limit }), null, 2);
  }
}

/** 查询主体：单条 issue 或工作列表；文本 / JSON 两种输出只在这里分叉。 */
async function runQuery(jira, { json, limit, rest, status, jql, scope, signal }) {
  if (rest && ISSUE_KEY.test(rest.toUpperCase())) {
    const key = rest.toUpperCase();
    const fields = [...LIST_FIELDS, await resolveSprintField(jira, signal), 'description', 'created', 'components', 'comment'];
    const issue = await jira.get(`/rest/api/3/issue/${encodeURIComponent(key)}`, { fields: fields.join(',') }, signal);
    return json
      ? JSON.stringify(buildIssueJson(issue, jira, await jira.priorityRanks(signal).catch(() => null)), null, 2)
      : renderIssue(issue, { settings: jira.settings, includeComments: true, commentLimit: 3 });
  }

  // 状态筛选必须插在 ORDER BY 之前（withJqlClause 负责），否则真实站点直接 400。
  const filteredJql = applyStatus(jql, status);
  // 面板高亮用的优先级名次跟搜索并行拿；拿不到就是 null，界面退回按名字判断，不拖慢也不影响这次查询。
  const ranksPromise = json ? jira.priorityRanks(signal).catch(() => null) : Promise.resolve(null);
  const page = await searchIssues(jira, filteredJql, limit, signal);
  const ranks = await ranksPromise;
  // 只有面板（--json）才多打这一次 count：命令行文本输出保持一次请求。
  const totals = json ? await workListCounts(jira, filteredJql, page.issues, signal) : undefined;
  // 文本输出刻意不再标注「活跃迭代」（用户 2026-11-18：这个 board 的 sprint 状态跟实际工作安排对不上，
  // 标出来会误导）；结构化输出里仍然保留这个字段，供界面或脚本自行取用。
  return json
    ? JSON.stringify(buildWorkListJson(page.issues, filteredJql, scope, jira, await fetchActiveSprint(jira, signal), { limit, hasMore: page.hasMore, status, ranks }, totals), null, 2)
    : renderWorkList(page.issues, filteredJql, scope, jira, page.hasMore ? page.limit : 0);
}

function resolveQuery(rawScope, rawJql) {
  const custom = typeof rawJql === 'string' ? rawJql.trim() : '';
  const scope = Object.prototype.hasOwnProperty.call(SCOPE_JQL, rawScope) ? rawScope : 'open';
  return { jql: custom || SCOPE_JQL[scope], scope: custom ? 'jql' : scope };
}

async function migrateLegacyToken(ctx, jira, settings) {
  const key = settings.credentialKey || DEFAULT_CREDENTIAL_KEY;
  const store = credentialStore(ctx);
  if (!store || typeof store.set !== 'function' || typeof store.resolve !== 'function') {
    jira.notes.push(t('note.credUnavailable', { key }));
    return;
  }
  try {
    const hit = await store.resolve(key);
    const existing = hit && typeof hit === 'object' ? hit.value : hit;
    if (typeof existing === 'string' && existing) return; // 凭据库已有值，保持不动
    await store.set(key, settings.apiToken);
    const back = await store.resolve(key);
    const stored = back && typeof back === 'object' ? back.value : back;
    if (typeof stored === 'string' && stored) {
      settings.apiToken = ''; // 本进程立即改用凭据库，验证写入确实生效
      jira.notes.push(t('note.tokenMigrated', { key }));
    } else {
      jira.notes.push(t('note.tokenMigrateUnreadable', { key }));
    }
  } catch (error) {
    jira.notes.push(t('note.tokenMigrateFailed', { message: error?.message ?? error }));
  }
}

function credentialStore(ctx) {
  if (typeof ctx?.get !== 'function') return undefined;
  try {
    return ctx.get('credentials');
  } catch {
    return undefined;
  }
}

/**
 * volatile 字段在运行时是「引用对象」（用 .get() 取当前值），普通字段就是原值。
 * 读配置时统一脱壳，两种形态都能处理。
 */
function unwrapValue(value) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
    try {
      return value.get();
    } catch {
      return undefined;
    }
  }
  return value;
}

/**
 * 运行时可改字段的取值顺序：本插件刚写下的覆盖值 → volatile 引用的当前值 → 归一化副本。
 * 覆盖值只在「宿主 settings 写入还没经 Loader 提交到引用」的空档里用一下，
 * 收到 loader/volatile-update 后会被清掉（引用随后就是权威值）。
 */
function liveSetting(settings, key, fallback) {
  const override = settings?.overrides ? settings.overrides[key] : undefined;
  if (override !== undefined) return override;
  const live = unwrapValue(settings?.live ? settings.live[key] : undefined);
  if (live !== undefined) return live;
  const value = settings?.[key];
  return value === undefined ? fallback : value;
}

/** 后台检查间隔（毫秒），下限 15s。 */
function intervalOf(settings) {
  const value = Number(liveSetting(settings, 'watchIntervalMs', DEFAULTS.watchIntervalMs));
  return Number.isFinite(value) && value > 0 ? Math.max(15000, Math.floor(value)) : DEFAULTS.watchIntervalMs;
}

/**
 * 条数语义的唯一归一化：**0 = 不限制**（调用方自己用 SAFETY_MAX 兜底），
 * 正数 clamp 到 10–5000，其它（非法 / 负数）回落到 fallback。
 * 命令 --limit、工具 limit、配置 maxResults、面板载荷全部走这里，别各写一份。
 */
function normalizeLimit(value, fallback = LIMIT_DEFAULT) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const whole = Math.floor(n);
  if (whole === 0) return 0;
  if (whole < 0) return fallback;
  return Math.min(LIMIT_MAX, Math.max(LIMIT_MIN, whole));
}

/** 每次拉取条数（volatile，配置页可改）：0 = 不限制（默认）；正数 10–5000。 */
function limitOf(settings) {
  return normalizeLimit(liveSetting(settings, 'maxResults', DEFAULTS.maxResults));
}

function normalizeConfig(config) {
  const raw = config && typeof config === 'object' ? config : {};
  const settings = { ...DEFAULTS };
  const read = (key) => unwrapValue(raw[key]);

  const baseUrl = read('baseUrl');
  if (typeof baseUrl === 'string' && baseUrl.trim()) {
    settings.baseUrl = baseUrl.trim().replace(/\/+$/, '');
  }
  for (const key of ['email', 'apiToken', 'credentialKey', 'projectKey']) {
    const value = read(key);
    if (typeof value === 'string' && value.trim()) settings[key] = value.trim();
  }
  const boardId = Number(read('boardId'));
  if (Number.isFinite(boardId)) settings.boardId = Math.floor(boardId);
  const maxResults = Number(read('maxResults'));
  if (Number.isFinite(maxResults)) settings.maxResults = normalizeLimit(maxResults);
  const timeoutMs = Number(read('timeoutMs'));
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) settings.timeoutMs = Math.floor(timeoutMs);
  const watchEnabled = read('watchEnabled');
  if (typeof watchEnabled === 'boolean') settings.watchEnabled = watchEnabled;
  const notify = read('notify');
  if (typeof notify === 'boolean') settings.notify = notify;
  const language = read('language');
  if (typeof language === 'string' && language.trim()) settings.language = language.trim();
  const watchIntervalMs = Number(read('watchIntervalMs'));
  if (Number.isFinite(watchIntervalMs) && watchIntervalMs > 0) {
    settings.watchIntervalMs = Math.max(15000, Math.floor(watchIntervalMs));
  }
  // 测试钩子：给了就代替 osascript 发通知（配置卡片里没有这一项，只给离线测试用）。
  const onNotify = read('onNotify');
  if (typeof onNotify === 'function') settings.onNotify = onNotify;
  // 测试钩子：给了就代替 execFile 真去开文件（配置卡片里没有这一项，只给离线测试用）。
  const onOpenPatch = read('onOpenPatch');
  if (typeof onOpenPatch === 'function') settings.onOpenPatch = onOpenPatch;
  // 测试钩子：给了就代替「扫盘找编辑器」（配置卡片里没有这一项，只给离线测试用）。
  const onDetectEditors = read('onDetectEditors');
  if (typeof onDetectEditors === 'function') settings.onDetectEditors = onDetectEditors;
  // 保留原始 config：volatile 引用会被 Loader 就地把新值写进去，所以这是「实时值」的来源。
  settings.live = raw;
  settings.overrides = {};

  return settings;
}

/**
 * token 解析顺序：DSH 凭据库 → 环境变量 → 插件 config。
 * 凭据库最优先，这样把密钥搬进凭据库之后就可以把 config 里的 apiToken 删掉。
 */
function createJira(ctx, settings) {
  const jira = {
    settings,
    /** 每次读到的凭据来自哪里，用于在输出里自证（从不回显值本身）。 */
    tokenSource: t('token.source.unread'),
    /** 启动期的一次性事件（例如明文 token 迁移），会在输出里提示。 */
    notes: [],
    /** 优先级顺序缓存 `{ ranks: Map, expires: number }`；见 priorityRanks()。 */
    priorityCache: null,

    /** 站点地址（必填，装完要在面板「配置」里填）。baseUrl 不是 volatile，读启动期快照即可。 */
    site() {
      return String(settings.baseUrl || '').trim();
    },

    /** 每个入口（工具 / 命令 / 路由 / 轮询）开工前同步一次语言。 */
    useLang(override) {
      return syncLang(ctx, settings, override);
    },

    async token() {
      const key = settings.credentialKey || DEFAULT_CREDENTIAL_KEY;
      const store = credentialStore(ctx);
      let storeError;
      if (store && typeof store.resolve === 'function') {
        try {
          const hit = await store.resolve(key);
          const value = hit && typeof hit === 'object' ? hit.value : hit;
          if (typeof value === 'string' && value) {
            jira.tokenSource = t('token.source.credential', { key });
            return value;
          }
        } catch (error) {
          // 凭据服务不可用时继续回退；三条路都没有值时，这个错误决定报「没配」还是「读不出」。
          storeError = error;
        }
      }
      const fromEnv = process.env[key];
      if (typeof fromEnv === 'string' && fromEnv) {
        jira.tokenSource = t('token.source.env', { key });
        return fromEnv;
      }
      if (settings.apiToken) {
        jira.tokenSource = t('token.source.config');
        return settings.apiToken;
      }
      if (storeError) {
        throw new JiraError('credential_unreadable', t('err.credentialUnreadable', {
          key,
          message: storeError?.message ?? storeError,
        }));
      }
      throw new JiraError('no_credential', t('err.noCredential', { key }));
    },

    /** 每次请求现读 email：它是 volatile 字段，配置页改完立刻生效，不用重装插件。 */
    email() {
      const value = liveSetting(settings, 'email', '');
      return typeof value === 'string' ? value.trim() : '';
    },

    async get(path, params, signal) {
      if (!this.site()) throw new JiraError('no_base_url', t('err.noBaseUrl'));
      if (!this.email()) throw new JiraError('no_email', t('err.noEmail'));
      const token = await this.token();

      const query = new URLSearchParams();
      for (const [name, value] of Object.entries(params ?? {})) {
        if (value === undefined || value === null || value === '') continue;
        query.set(name, String(value));
      }
      const qs = query.toString();
      const url = `${settings.baseUrl}${path}${qs ? `?${qs}` : ''}`;

      const auth = Buffer.from(`${this.email()}:${token}`, 'utf8').toString('base64');
      let response;
      try {
        response = await fetch(url, {
          method: 'GET',
          headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
          signal,
        });
      } catch (error) {
        // 网络层失败（DNS、代理、被对端断开）不是 HTTP 错误，fetch 只给一句 "fetch failed"，
        // 这里把 cause 里的真实原因带出来，方便自查。
        if (signal?.aborted) throw error;
        const cause = error?.cause?.code ?? error?.cause?.message ?? error?.message ?? error;
        throw new JiraError('network', t('err.network', { baseUrl: settings.baseUrl, path, cause }));
      }
      const text = await response.text();

      let body;
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined;
      }

      if (!response.ok) {
        throw httpFailure(response.status, response.statusText, path, jiraErrorDetail(body, text));
      }
      if (body === undefined) throw new JiraError('not_json', t('err.notJson', { path }));
      return body;
    },

    /** 写操作（目前只用于状态流转）。Jira 成功时可能返回 204，所以允许空 body。 */
    async post(path, payload, signal) {
      if (!this.site()) throw new JiraError('no_base_url', t('err.noBaseUrl'));
      if (!this.email()) throw new JiraError('no_email', t('err.noEmail'));
      const token = await this.token();
      const auth = Buffer.from(`${this.email()}:${token}`, 'utf8').toString('base64');

      let response;
      try {
        response = await fetch(`${settings.baseUrl}${path}`, {
          method: 'POST',
          headers: {
            Authorization: `Basic ${auth}`,
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: payload === undefined ? undefined : JSON.stringify(payload),
          signal,
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        const cause = error?.cause?.code ?? error?.cause?.message ?? error?.message ?? error;
        throw new JiraError('network', t('err.network', { baseUrl: settings.baseUrl, path, cause }));
      }

      const text = await response.text();
      let body;
      try {
        body = text ? JSON.parse(text) : undefined;
      } catch {
        body = undefined;
      }
      if (!response.ok) {
        throw httpFailure(response.status, response.statusText, path, jiraErrorDetail(body, text));
      }
      return body;
    },

    /**
     * 站点的优先级名次表：`id:<id>` / `name:<小写名字>` → 下标（0 = Jira 里的最高级）。
     * 界面拿这个下标决定谁整行上底色，所以站点改了顺序、或用 P0/Blocker 这类自定义名字也跟着走，
     * 不需要在客户端写死 "Highest" 是最高级。取不到就回空表，界面退回按名字判断。
     * 缓存见 PRIORITY_TTL_MS；被主动取消（abort）不写缓存，免得把「取消」当成「站点没这个接口」。
     */
    async priorityRanks(signal) {
      const now = Date.now();
      if (this.priorityCache && now < this.priorityCache.expires) return this.priorityCache.ranks;
      let ranks = new Map();
      let ttl = PRIORITY_TTL_MS;
      try {
        const list = await this.get(PRIORITY_PATH, {}, signal);
        if (Array.isArray(list)) {
          const next = new Map();
          list.forEach((entry, index) => {
            const id = String(entry?.id ?? '').trim();
            const name = String(entry?.name ?? '').trim().toLowerCase();
            if (id) next.set(`id:${id}`, index);
            if (name) next.set(`name:${name}`, index);
          });
          ranks = next;
        }
      } catch (error) {
        if (signal?.aborted) throw error;
        ttl = PRIORITY_FAIL_TTL_MS;
      }
      this.priorityCache = { ranks, expires: now + ttl };
      return ranks;
    },
  };

  return jira;
}

/** Jira 的错误详情：errorMessages 数组 + errors 字段映射，都没有才退回正文前 300 字。 */
function jiraErrorDetail(body, text) {
  const messages = Array.isArray(body?.errorMessages) ? body.errorMessages.filter(Boolean) : [];
  const fields = body?.errors && typeof body.errors === 'object'
    ? Object.entries(body.errors).map(([name, message]) => `${name}: ${message}`)
    : [];
  const detail = [...messages, ...fields].join('; ');
  if (detail) return detail;
  if (typeof body?.message === 'string' && body.message) return body.message;
  return String(text ?? '').slice(0, 300) || t('err.noDetail');
}

// 准确总数：`approximate-count` 只回一个 count（实测与「自己翻页把结果全拉完」完全一致，例如未完成
// 9 = 9、全部 332 = 332（4 页）），不是当前页条数。任何失败都返回 undefined —— 界面拿不到就不显示数字
// （用户 2026-11-18 的口径：宁可空着，也不给一个会变的数）。
async function countIssues(jira, jql, signal) {
  try {
    const body = await jira.post(COUNT_PATH, { jql }, signal);
    const value = Number(body?.count);
    return Number.isFinite(value) && value >= 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

// 结果里出现了哪些项目（issue key 的前缀就是项目键）。
function projectNamesOf(issues) {
  const names = [];
  for (const issue of issues) {
    const name = String(issue?.key ?? '').split('-')[0];
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

// 给 JQL 追加一个 AND 条件：**`ORDER BY` 必须是最后一句**——直接字符串拼接会得到
// `… statusCategory != Done ORDER BY status ASC AND project = "APP"` 这种非法 JQL（真站点回 400，
// 于是 projectTotals 变成空对象；这正是本机实测踩到的坑）。状态筛选（--status=）和项目计数都走这里。
function withJqlClause(jql, clause) {
  const text = typeof clause === 'string' ? clause.trim() : '';
  if (!text) return jql;
  const match = /\s+ORDER\s+BY\s+/i.exec(jql);
  const head = match ? jql.slice(0, match.index) : jql;
  const tail = match ? jql.slice(match.index) : '';
  return `${head} AND ${text}${tail}`;
}

function withProjectClause(jql, name) {
  return withJqlClause(jql, `project = "${name}"`);
}

// 面板要的两个数字：当前查询的总数、以及每个项目的总数（项目太多时只给总数）。
async function workListCounts(jira, jql, issues, signal) {
  const total = await countIssues(jira, jql, signal);
  const names = projectNamesOf(issues);
  if (names.length === 0 || names.length > MAX_COUNT_PROJECTS) return { total };
  const values = await Promise.all(names.map((name) => countIssues(jira, withProjectClause(jql, name), signal)));
  const projectTotals = {};
  names.forEach((name, index) => {
    if (Number.isFinite(values[index])) projectTotals[name] = values[index];
  });
  return { total, projectTotals };
}

/**
 * 拉取 issue 列表：limit = 0 表示「取到完为止」——一直翻页到 isLast / 没有 nextPageToken /
 * 单页空为止，刹车是 MAX_PAGES（50 页 = 5000 条）与 timeoutMs（整轮翻页的总预算，默认 30s）。
 * limit > 0 时就按它当上限（仍然逐页取，不一次要 5000 条）。
 * 达到任一安全上限时 hasMore = true（如实告诉调用方「后面还有」）；总数是累加值，不再截断。
 */
async function searchIssues(jira, jql, limit, signal) {
  const requested = normalizeLimit(limit, LIMIT_DEFAULT);
  const cap = requested > 0 ? requested : SAFETY_MAX;
  // 整轮翻页共用一个总超时：0 = 不限制时它是 MAX_PAGES 之外的最后一道刹车，
  // 避免一条大 JQL 把面板/工具拖死。调用方自己的 signal（工具/命令的中断）照旧生效，两个一起用。
  const budgetMs = Math.max(1000, Math.floor(Number(jira.settings.timeoutMs) || DEFAULTS.timeoutMs));
  const timeoutSignal = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(budgetMs) : undefined;
  const combinedSignal = signal && timeoutSignal && typeof AbortSignal?.any === 'function'
    ? AbortSignal.any([signal, timeoutSignal])
    : (signal ?? timeoutSignal);
  const issues = [];
  let pageToken;
  let finished = false; // 自然翻到底（isLast / 没有下一页 / 空页）
  let truncated = false; // 被安全上限或总超时打断：后面确实还有
  const sprintField = await resolveSprintField(jira, signal);
  const fields = [...LIST_FIELDS, sprintField].join(',');

  for (let page = 0; page < MAX_PAGES && issues.length < cap; page += 1) {
    const params = {
      jql,
      fields,
      maxResults: Math.min(PAGE_SIZE, cap - issues.length),
    };
    if (pageToken) params.nextPageToken = pageToken;

    let body;
    try {
      body = await jira.get(SEARCH_PATH, params, combinedSignal);
    } catch (error) {
      // 总超时到点：已经拿到的部分照常返回，并如实标「还有更多」（别把半截结果说成取完了）。
      // 调用方自己的 signal 中断（用户切 tab / 取消）照旧往外抛，那是真的取消。
      if (issues.length > 0 && timeoutSignal?.aborted === true && signal?.aborted !== true) {
        truncated = true;
        break;
      }
      throw error;
    }
    const batch = Array.isArray(body?.issues) ? body.issues : [];
    issues.push(...batch);
    pageToken = body?.nextPageToken;

    if (!pageToken || body?.isLast === true || batch.length === 0) {
      finished = true;
      break;
    }
  }

  // 还有下一页、而且这一批已经顶到上限（调用方给的条数 / 50 页安全上限）→「还有更多」；
  // 被总超时打断（truncated）同样如实标 true。总数是累加值，不再 slice 截断。
  const hasMore = truncated || (!finished && Boolean(pageToken) && issues.length >= cap);
  return { issues, hasMore, limit: cap };
}

/**
 * Sprint 字段 id 每个 jira 实例只解析一次：先按 schema 从字段表里找（站点改语言也不受影响），
 * 查不到就用本站点的已知 id，再不行就当作没有 sprint 字段（列表退化成「无迭代」一组）。
 */
async function resolveSprintField(jira, signal) {
  if (jira.sprintField !== undefined) return jira.sprintField;
  try {
    const fields = await jira.get('/rest/api/3/field', {}, signal);
    const match = Array.isArray(fields)
      ? fields.find((field) => field?.schema?.custom === SPRINT_FIELD_SCHEMA)
      : undefined;
    jira.sprintField = typeof match?.id === 'string' ? match.id : SPRINT_FIELD_FALLBACK;
  } catch {
    jira.sprintField = SPRINT_FIELD_FALLBACK;
  }
  return jira.sprintField;
}

/** 一条 issue 的 sprint 字段可能是数组（被搬过迭代）；优先当前活跃的那个，否则取 id 最大的。 */
function sprintOf(issue, fieldId) {
  if (!fieldId) return undefined;
  const raw = issue?.fields?.[fieldId];
  const list = (Array.isArray(raw) ? raw : raw ? [raw] : []).filter((row) => row && typeof row === 'object');
  if (list.length === 0) return undefined;
  return list.find((row) => row.state === 'active')
    ?? [...list].sort((a, b) => Number(b.id ?? 0) - Number(a.id ?? 0))[0];
}

// --------------------------------------------------------------- 后台监视
//
// Jira Cloud 没有给第三方 issue 事件的「长连接」接口（没有 websocket/SSE，官方推送只有 webhook），
// 所以实时性靠本机轮询：插件在自己的 fiber 上挂一个定时器，每 watchIntervalMs 查一次
// 「指派给我且未完成」的 issue，和上一轮比对；新增指派或状态变化就弹一条系统通知，
// 并把变化记进 pending。面板角标不去轮询命令（那会往会话里写 command 事件），
// 而是由 client 半边长轮询 connection.fetch 上的一条精确路由读 pending。

const WATCH_JQL = SCOPE_JQL.open;
const WATCH_FIELDS = ['summary', 'status', 'updated', 'duedate', 'priority', 'issuetype', 'parent', 'labels'];
/** 精确 Fetch 路由：client-connection 的 connection.fetch 要求路径落在 /api 之下。 */
const WATCH_PATH = '/api/jira-work-overview/state';
const WATCH_MAX_WAIT_MS = 25000;
const WATCH_MAX_CHANGES = 100;

/**
 * 起手先建一次基线（只记不发），之后的 diff 才通知。
 * 定时器用原生 setInterval + ctx.effect 挂到插件 fiber 上（卸载即清理）。
 */
function startWatcher(ctx, jira, settings) {
  const state = {
    enabled: liveSetting(settings, 'watchEnabled', true) !== false,
    intervalMs: intervalOf(settings),
    startedAt: new Date().toISOString(),
    checkedAt: '',
    lastChangeAt: '',
    checks: 0,
    failures: 0,
    lastError: '',
    /** 失败的类型（见 errorCodeOf / JiraError）；面板据此给「凭据没配」这类提示，而不是糊一句原文。 */
    lastErrorCode: '',
    baseline: false,
    pending: [],
    seen: new Map(),
    waiters: new Set(),
  };

  let stopped = false;
  let timer = null;
  const clear = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  // 自排程：每次跑完都按「此刻」的配置决定下一次什么时候跑，
  // 所以改完轮询间隔 / 关掉开关都不需要重装插件（volatile 引用会实时更新）。
  const schedule = (delay) => {
    clear();
    if (stopped) return;
    state.enabled = liveSetting(settings, 'watchEnabled', true) !== false;
    state.intervalMs = intervalOf(settings);
    if (!state.enabled) return;
    timer = setTimeout(() => {
      timer = null;
      void tick();
    }, Math.max(1500, Math.floor(delay)));
    if (typeof timer?.unref === 'function') timer.unref();
  };

  const tick = async () => {
    try {
      // 每次轮询前同步语言：通知标题 / 正文用的是此刻的设置。
      jira.useLang();
      await pollWatch(jira, state);
    } catch {
      /* pollWatch 已经把失败记进 state.lastError */
    }
    schedule(state.intervalMs);
  };

  /** 配置变了就重排下一次检查（面板里的配置表单保存后会调）。 */
  state.reschedule = () => { schedule(state.intervalMs); };

  // 起手延迟一拍再建基线，避免和插件启动抢网络。
  schedule(1500);

  // volatile 字段被 Host（设置界面 / 本插件面板）改写后，Loader 会发这个事件；
  // 此时引用已经是新值，把临时覆盖清掉并重排定时器。
  if (typeof ctx?.on === 'function') {
    try {
      ctx.on('loader/volatile-update', (paths) => {
        const list = Array.isArray(paths) ? paths : [];
        for (const path of list) {
          const key = Array.isArray(path) ? path[0] : path;
          if (key !== undefined && settings.overrides) delete settings.overrides[key];
        }
        state.reschedule();
      });
    } catch {
      /* 事件不可用就算了，定时器继续按老间隔跑 */
    }
  }

  // 定时器用原生的：cordis 的 timer 服务只能通过 ctx.timer / ctx.interval 访问，
  // 而读取未在 inject 里声明的服务会直接抛（cannot get property "timer" without inject）；
  // 为了不因为「宿主没有 timer 服务」就让插件停成 pending，这里用原生 setTimeout，
  // 再用 ctx.effect 把它挂在插件 fiber 上（卸载即清理）。
  try {
    if (typeof ctx?.effect === 'function') {
      ctx.effect(() => () => {
        stopped = true;
        clear();
      }, 'jira-work-overview: watch timer');
    }
  } catch {
    /* effect 不可用就算了，定时器继续跑 */
  }

  return state;
}

async function pollWatch(jira, state) {
  const signal = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(jira.settings.timeoutMs) : undefined;
  let body;
  try {
    body = await jira.get(SEARCH_PATH, {
      jql: WATCH_JQL,
      fields: WATCH_FIELDS.join(','),
      maxResults: 50,
    }, signal);
  } catch (error) {
    state.failures += 1;
    state.lastError = String(error?.message ?? error);
    state.lastErrorCode = errorCodeOf(error);
    state.checkedAt = new Date().toISOString();
    throw error;
  }

  const next = new Map();
  for (const issue of Array.isArray(body?.issues) ? body.issues : []) {
    const key = issue?.key;
    if (!key) continue;
    next.set(key, {
      summary: String(issue.fields?.summary ?? '').trim(),
      status: issue.fields?.status?.name ?? '',
      category: issue.fields?.status?.statusCategory?.key ?? '',
    });
  }

  state.checks += 1;
  state.failures = 0;
  state.lastError = '';
  state.lastErrorCode = '';
  state.checkedAt = new Date().toISOString();

  if (!state.baseline) {
    state.seen = next;
    state.baseline = true;
    return;
  }

  const at = state.checkedAt;
  const changes = [];
  for (const [key, row] of next) {
    const before = state.seen.get(key);
    if (!before) {
      changes.push({ kind: 'new', key, summary: row.summary, status: row.status, at });
    } else if (before.status !== row.status) {
      changes.push({ kind: 'status', key, summary: row.summary, from: before.status, to: row.status, at });
    }
  }
  for (const [key, before] of state.seen) {
    if (!next.has(key)) {
      changes.push({ kind: 'closed', key, summary: before.summary, from: before.status, to: '', at });
    }
  }
  state.seen = next;
  if (!changes.length) return;

  state.pending.push(...changes);
  if (state.pending.length > WATCH_MAX_CHANGES) {
    state.pending.splice(0, state.pending.length - WATCH_MAX_CHANGES);
  }
  state.lastChangeAt = at;

  // 只有「新指派」和「状态变化」值得打扰；issue 离开未完成列表只记不弹。
  const loud = changes.filter((change) => change.kind !== 'closed');
  if (loud.length) void deliverWatchNotification(jira.settings, loud);
  wakeWatchWaiters(state);
}

/** 让正在长轮询的请求立刻拿到新状态。 */
function wakeWatchWaiters(state) {
  for (const wake of [...state.waiters]) wake();
}

/** 给面板看的快照（最近的变化在前）。 */
function watchSnapshot(state) {
  if (!state) return null;
  const counts = { new: 0, status: 0, closed: 0 };
  for (const change of state.pending) {
    if (Object.prototype.hasOwnProperty.call(counts, change.kind)) counts[change.kind] += 1;
  }
  return {
    enabled: state.enabled,
    intervalMs: state.intervalMs,
    startedAt: state.startedAt,
    checkedAt: state.checkedAt,
    lastChangeAt: state.lastChangeAt,
    checks: state.checks,
    failures: state.failures,
    lastError: state.lastError,
    lastErrorCode: state.lastErrorCode,
    baseline: state.baseline,
    counts: { ...counts, total: state.pending.length },
    changes: state.pending.slice(-20).reverse(),
  };
}

/** 面板「标记已读」：清空未读变化，返回清掉的条数。 */
function ackWatch(state) {
  if (!state) return 0;
  const cleared = state.pending.length;
  state.pending = [];
  return cleared;
}

async function deliverWatchNotification(settings, changes) {
  const title = changes.length === 1 && changes[0].kind === 'new'
    ? t('notify.newAssignTitle')
    : t('notify.changesTitle', { count: changes.length });
  // 通知正文限长：Windows Toast 与 macOS 通知都会截断，自己先截到 200 字符更可控。
  const message = truncate(changes.slice(0, 4).map(describeChange).join(t('sep.change')), 200);
  // 测试钩子优先；配置卡片里没有 onNotify，只有离线测试会传。
  if (typeof settings.onNotify === 'function') {
    try {
      await settings.onNotify(title, message);
    } catch {
      /* 通知失败不影响监视 */
    }
    return;
  }
  if (liveSetting(settings, 'notify', true) === false) return;
  await notifyDesktop(title, message);
}

/**
 * 桌面通知：macOS 走 osascript、Windows 走 PowerShell 的 WinRT Toast、其它平台试 notify-send。
 * 一律**失败静默**——通知不该影响监视循环，也不该因为平台差异抛错。
 */
async function notifyDesktop(title, message) {
  try {
    const { execFile } = await import('node:child_process');
    if (process.platform === 'darwin') {
      const script = `display notification ${appleScriptString(message)} with title ${appleScriptString(title)}`;
      execFile('osascript', ['-e', script], () => { /* 静默 */ });
      return true;
    }
    if (process.platform === 'win32') {
      // powershell.exe 是 Win10+ 自带的；用 -EncodedCommand 传 UTF-16LE base64，
      // 绕开 cmd/PowerShell 的引号、换行与中文代码页问题。
      execFile('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', powerShellEncoded(windowsToastScript(title, message))],
        { windowsHide: true },
        () => { /* 静默：可能没有交互式桌面会话，或被组策略禁用 */ });
      return true;
    }
    // Linux 等：有 libnotify 就有通知，没有就当没有通知能力（角标照常）。
    execFile('notify-send', [title, message], () => { /* 静默 */ });
    return true;
  } catch {
    return false;
  }
}

/** PowerShell Toast（ToastText02 = 标题 + 正文）。不注册 AUMID：失败也只是没有通知，不影响角标。 */
function windowsToastScript(title, message) {
  return [
    '$ErrorActionPreference = "Stop"',
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime] > $null',
    '$template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)',
    '$texts = $template.GetElementsByTagName("text")',
    `$texts.Item(0).AppendChild($template.CreateTextNode(${powerShellString(title)})) > $null`,
    `$texts.Item(1).AppendChild($template.CreateTextNode(${powerShellString(message)})) > $null`,
    '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("DeepSeek Harness").Show([Windows.UI.Notifications.ToastNotification]::new($template))',
  ].join('; ');
}

/** PowerShell 单引号字面量：内部单引号翻倍（换行、中文、emoji 都安全）。 */
function powerShellString(value) {
  return `'${String(value ?? '').replace(/'/g, "''")}'`;
}

/** -EncodedCommand 要求 UTF-16LE 的 base64。 */
function powerShellEncoded(script) {
  return Buffer.from(String(script), 'utf16le').toString('base64');
}

function describeChange(change) {
  if (change.kind === 'new') {
    return t('change.new', { key: change.key, summary: truncate(change.summary, 36), status: change.status });
  }
  if (change.kind === 'status') return t('change.status', { key: change.key, from: change.from, to: change.to });
  return t('change.closed', { key: change.key });
}

/** AppleScript 字符串字面量：转义反斜杠和双引号。 */
function appleScriptString(value) {
  return `"${String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function truncate(value, max) {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * 面板角标的数据通道：在 connection.fetch 注册一条精确路由（GET=状态，可长轮询；POST=标记已读）。
 * 走这条而不是斜杠命令，是因为每次命令执行都会往会话里写 command/run + command/done，
 * 拿它做轮询会把聊天记录刷爆。服务不存在时只记一条提示，工具与系统通知照常。
 */
function registerWatchRoute(ctx, jira, state) {
  const connection = safeService(ctx, 'connection');
  const registry = connection?.fetch;
  if (!registry || typeof registry.register !== 'function') {
    jira.notes.push(
      t('note.noWatchRoute', { path: WATCH_PATH }),
    );
    return;
  }
  try {
    registry.register({
      path: WATCH_PATH,
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      async fetch(request) {
        const reportedLang = new URL(request.url).searchParams.get('lang');
        rememberReportedLang(reportedLang);
        jira.useLang(reportedLang);
        if (request.method === 'POST') {
          const cleared = ackWatch(state);
          return jsonResponse({ ok: true, cleared, watch: watchSnapshot(state) });
        }
        const url = new URL(request.url);
        const wait = clampInt(url.searchParams.get('wait'), 0, WATCH_MAX_WAIT_MS, 0);
        if (wait > 0 && state?.pending.length === 0) {
          await waitForWatchChange(state, wait, request.signal);
        }
        return jsonResponse({ ok: true, watch: watchSnapshot(state), now: new Date().toISOString() });
      },
    });
  } catch (error) {
    jira.notes.push(t('note.noWatchRouteError', { path: WATCH_PATH, message: error?.message ?? error }));
  }
}

function waitForWatchChange(state, ms, signal) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      state.waiters.delete(finish);
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    if (typeof timer?.unref === 'function') timer.unref();
    state.waiters.add(finish);
    signal?.addEventListener?.('abort', finish, { once: true });
  });
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function safeService(ctx, name) {
  if (typeof ctx?.get !== 'function') return undefined;
  try {
    return ctx.get(name);
  } catch {
    return undefined;
  }
}

// ------------------------------------------------------------- 状态流转
//
// Jira 不允许「随便写一个状态名」：只能执行工作流允许的**流转**（transition）。
// 所以要改状态，先 GET /issue/{key}/transitions 拿到这个 issue 此刻可用的流转列表
// （它就是面板里那个下拉框），再 POST /issue/{key}/transitions 带 transition.id。
// 成功通常是 204 无 body，所以写入后回读一次状态再把新状态报回去。

const TRANSITION_PATH = '/api/jira-work-overview/transition';

// 令牌的读写通道：值只往凭据库走，回给界面的永远是打码后的首尾。
const CREDENTIAL_PATH = '/api/jira-work-overview/credential';
const MASK_EDGE = 4;

/** 可用的流转 + 当前状态（两份数据并成一个响应，面板一次请求就够）。 */
async function listTransitions(jira, key, signal) {
  const [issue, body] = await Promise.all([
    jira.get(`/rest/api/3/issue/${encodeURIComponent(key)}`, { fields: 'status' }, signal),
    jira.get(`/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, { expand: 'transitions.fields' }, signal),
  ]);
  const status = issue?.fields?.status ?? {};
  const transitions = (Array.isArray(body?.transitions) ? body.transitions : []).map((row) => ({
    id: String(row?.id ?? ''),
    name: String(row?.name ?? ''),
    to: String(row?.to?.name ?? ''),
    category: row?.to?.statusCategory?.key ?? '',
    // 有些工作流要求流转时填必填字段；这里先只报出来，真缺字段时 Jira 会返回 400。
    required: Object.values(row?.fields ?? {})
      .filter((field) => field?.required)
      .map((field) => String(field?.name ?? '')),
  }));
  return {
    key,
    current: String(status?.name ?? ''),
    currentCategory: status?.statusCategory?.key ?? '',
    transitions,
  };
}

/** 执行流转并回读新状态。 */
async function applyTransition(jira, key, transitionId, signal) {
  await jira.post(
    `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`,
    { transition: { id: String(transitionId) } },
    signal,
  );
  const issue = await jira.get(`/rest/api/3/issue/${encodeURIComponent(key)}`, { fields: 'status' }, signal);
  const status = issue?.fields?.status ?? {};
  return { key, status: String(status?.name ?? ''), category: status?.statusCategory?.key ?? '' };
}

/** 把「流转 id / 目标状态名 / 流转名」都解析成同一个流转，便于人和模型随便写。 */
function matchTransition(list, wanted) {
  const needle = String(wanted ?? '').trim().toLowerCase();
  if (!needle) return undefined;
  return list.find((row) => row.id === needle)
    ?? list.find((row) => row.to.toLowerCase() === needle)
    ?? list.find((row) => row.name.toLowerCase() === needle)
    ?? list.find((row) => row.to.toLowerCase().includes(needle));
}

/**
 * 面板改状态用的精确路由：GET ?key=… 列可用流转，POST {key, transitionId} 执行流转。
 * 这是插件里唯一的写操作，所以参数校验做在host 侧（key 必须像 APP-123，id 必须给）。
 */
function registerTransitionRoute(ctx, jira) {
  const registry = safeService(ctx, 'connection')?.fetch;
  if (!registry || typeof registry.register !== 'function') return;
  try {
    registry.register({
      path: TRANSITION_PATH,
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      async fetch(request) {
        const reportedLang = new URL(request.url).searchParams.get('lang');
        rememberReportedLang(reportedLang);
        jira.useLang(reportedLang);
        try {
          if (request.method === 'POST') {
            const payload = await request.json().catch(() => ({}));
            const key = String(payload?.key ?? '').trim().toUpperCase();
            if (!ISSUE_KEY.test(key)) {
              return jsonResponse({ ok: false, error: t('err.invalidKey', { key: payload?.key ?? '' }) }, 400);
            }
            const id = payload?.transitionId ?? payload?.transition;
            if (id === undefined || id === null || String(id).trim() === '') {
              return jsonResponse({ ok: false, error: t('err.missingTransitionId') }, 400);
            }
            const result = await applyTransition(jira, key, id, request.signal);
            return jsonResponse({ ok: true, ...result, watch: watchSnapshot(jira.watch) });
          }
          const key = String(new URL(request.url).searchParams.get('key') ?? '').trim().toUpperCase();
          if (!ISSUE_KEY.test(key)) {
            return jsonResponse({ ok: false, error: t('err.invalidKey', { key }) }, 400);
          }
          return jsonResponse({ ok: true, ...(await listTransitions(jira, key, request.signal)) });
        } catch (error) {
          return jsonResponse({ ok: false, error: String(error?.message ?? error) }, 400);
        }
      },
    });
  } catch (error) {
    jira.notes.push(t('note.noTransitionRoute', { path: TRANSITION_PATH, message: error?.message ?? error }));
  }
}

/**
 * 配置页要显示的「当前生效配置」——只有非敏感字段（令牌永远不进这里）。
 */
function publicSettings(settings) {
  return {
    baseUrl: settings.baseUrl,
    email: liveSetting(settings, 'email', '') || t('err.emailNotSet'),
    projectKey: settings.projectKey,
    boardId: settings.boardId,
    credentialKey: settings.credentialKey || DEFAULT_CREDENTIAL_KEY,
    maxResults: limitOf(settings),
    timeoutMs: settings.timeoutMs,
    watchEnabled: liveSetting(settings, 'watchEnabled', true) !== false,
    watchIntervalMs: intervalOf(settings),
    notify: liveSetting(settings, 'notify', true) !== false,
  };
}

/**
 * 打码：只留首尾各 MASK_EDGE 个字符，中间用省略号。界面拿到的永远是这个字符串，
 * 完整令牌只在 Host 进程里流转一次（凭据库 → Basic 认证头）。
 */
function maskToken(value) {
  const token = typeof value === 'string' ? value : '';
  if (!token) return '';
  if (token.length <= MASK_EDGE * 2) return `${token.slice(0, 1)}…${token.slice(-1)}`;
  return `${token.slice(0, MASK_EDGE)}…${token.slice(-MASK_EDGE)}`;
}

/**
 * 当前凭据来自哪里（凭据库 / 环境变量 / 插件配置明文），并把值打码后带回去。
 * 配置页用它显示「当前令牌」，所以这里绝不能回传完整值。
 */
async function credentialStatus(ctx, settings) {
  const status = await credentialStatusRaw(ctx, settings);
  // 邮箱是可改字段（volatile），界面要用原文回填输入框，所以单独给一份不带文案的。
  return { ...status, email: String(liveSetting(settings, 'email', '') ?? '').trim() };
}

async function credentialStatusRaw(ctx, settings) {
  const key = settings.credentialKey || DEFAULT_CREDENTIAL_KEY;
  const store = credentialStore(ctx);

  if (store && typeof store.resolve === 'function') {
    try {
      const hit = await store.resolve(key);
      const value = hit && typeof hit === 'object' ? hit.value : hit;
      if (typeof value === 'string' && value) {
        return {
          credentialKey: key,
          configured: true,
          source: 'credential',
          settings: publicSettings(settings),
          sourceLabel: t('token.source.credential', { key }),
          masked: maskToken(value),
          length: value.length,
        };
      }
    } catch (error) {
      return {
        credentialKey: key,
        configured: false,
        source: 'error',
        settings: publicSettings(settings),
        sourceLabel: t('token.source.readFailed', { message: error?.message ?? error }),
        masked: '',
        length: 0,
      };
    }
  }

  const fromEnv = process.env[key];
  if (typeof fromEnv === 'string' && fromEnv) {
    return {
      credentialKey: key,
      configured: true,
      source: 'env',
      settings: publicSettings(settings),
      sourceLabel: t('token.source.envNotStore', { key }),
      masked: maskToken(fromEnv),
      length: fromEnv.length,
    };
  }
  if (settings.apiToken) {
    return {
      credentialKey: key,
      configured: true,
      source: 'config',
      settings: publicSettings(settings),
      sourceLabel: t('token.source.configAlt'),
      masked: maskToken(settings.apiToken),
      length: settings.apiToken.length,
    };
  }
  return {
    credentialKey: key,
    configured: false,
    source: 'missing',
    settings: publicSettings(settings),
    sourceLabel: t('token.source.missing', { key }),
    masked: '',
    length: 0,
  };
}

/** 抽出现在生效的令牌原文（只在 Host 进程里流转）。 */
async function resolveToken(ctx, settings) {
  const key = settings.credentialKey || DEFAULT_CREDENTIAL_KEY;
  const store = credentialStore(ctx);
  if (store && typeof store.resolve === 'function') {
    try {
      const hit = await store.resolve(key);
      const value = hit && typeof hit === 'object' ? hit.value : hit;
      if (typeof value === 'string' && value) {
        return { value, key, source: 'credential', sourceLabel: t('token.source.credential', { key }) };
      }
    } catch (error) {
      return { value: '', key, source: 'error', sourceLabel: t('token.source.readFailed', { message: error?.message ?? error }) };
    }
  }
  const fromEnv = typeof process !== 'undefined' ? process.env?.[key] : undefined;
  if (typeof fromEnv === 'string' && fromEnv) {
    return { value: fromEnv, key, source: 'env', sourceLabel: t('token.source.envNotStore', { key }) };
  }
  if (typeof settings.apiToken === 'string' && settings.apiToken) {
    return { value: settings.apiToken, key, source: 'config', sourceLabel: t('token.source.configAlt') };
  }
  return { value: '', key, source: 'missing', sourceLabel: t('token.source.missing', { key }) };
}

/**
 * 拿候选「邮箱 + 令牌」试一次 /myself：能分清「这个组合不对」（401/403）与「网络不通」。
 * email 省略时用当前生效的邮箱。
 */
async function verifyCredential(settings, token, signal, email) {
  const account = typeof email === 'string' && email ? email : liveSetting(settings, 'email', '');
  const auth = Buffer.from(`${account}:${token}`, 'utf8').toString('base64');
  const response = await fetch(`${settings.baseUrl}/rest/api/3/myself`, {
    headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
    signal,
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  if (response.ok) {
    return {
      ok: true,
      account: body?.displayName ?? '',
      accountId: body?.accountId ?? '',
      email: body?.emailAddress ?? '',
    };
  }
  return { ok: false, status: response.status, message: jiraErrorDetail(body, text) };
}

/**
 * 配置页的令牌读写通道（GET 状态 / POST 保存或清除）。
 * 保存前先用这个令牌打一次 /myself：401/403 直接拒绝，避免把插件写成一个打不通的状态；
 * 只有网络层失败才「照存但提示」。
 */
function registerCredentialRoute(ctx, jira, settings) {
  const registry = safeService(ctx, 'connection')?.fetch;
  if (!registry || typeof registry.register !== 'function') {
    jira.notes.push(
      t('note.noCredentialRoute', { path: CREDENTIAL_PATH, key: settings.credentialKey || DEFAULT_CREDENTIAL_KEY }),
    );
    return;
  }
  try {
    registry.register({
      path: CREDENTIAL_PATH,
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      async fetch(request) {
        const reportedLang = new URL(request.url).searchParams.get('lang');
        rememberReportedLang(reportedLang);
        jira.useLang(reportedLang);
        const key = settings.credentialKey || DEFAULT_CREDENTIAL_KEY;
        try {
          if (request.method !== 'POST') {
            return jsonResponse({ ok: true, ...(await credentialStatus(ctx, settings)) });
          }
          const payload = await request.json().catch(() => ({}));
          const store = credentialStore(ctx);

          if (payload?.clear === true) {
            if (!store || typeof store.unset !== 'function') {
              return jsonResponse({ ok: false, error: t('err.noUnset') }, 400);
            }
            await store.unset(key);
            return jsonResponse({ ok: true, cleared: true, ...(await credentialStatus(ctx, settings)) });
          }

          // 令牌与邮箱是一对：都从 payload 里取，缺的那一半用当前生效值。
          const token = typeof payload?.token === 'string' ? payload.token.trim() : '';
          const rawEmail = typeof payload?.email === 'string' ? payload.email.trim() : '';
          const current = await resolveToken(ctx, settings);
          const currentEmail = String(liveSetting(settings, 'email', '') ?? '').trim();
          const nextEmail = rawEmail || currentEmail;

          if (!nextEmail) return jsonResponse({ ok: false, error: t('err.needEmail') }, 400);
          if (rawEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail)) {
            return jsonResponse({ ok: false, error: t('err.badEmail', { email: rawEmail }) }, 400);
          }
          if (token && token.length < 8) return jsonResponse({ ok: false, error: t('err.tokenTooShort') }, 400);
          const candidate = token || current.value;
          if (!candidate) return jsonResponse({ ok: false, error: t('err.noToken') }, 400);

          // 组合验证：401/403 说明「邮箱 + 令牌」这个组合不对，两边都不写；
          // 网络层失败照存但提示（同令牌单独保存时的策略）。
          let verification = { skipped: true, reason: t('verify.skipped') };
          try {
            const probe = await verifyCredential(settings, candidate, request.signal, nextEmail);
            verification = probe;
            if (probe.ok === false && (probe.status === 401 || probe.status === 403)) {
              return jsonResponse({
                ok: false,
                rejected: true,
                error: t('err.rejected', { status: probe.status, message: probe.message }),
              }, 400);
            }
          } catch (error) {
            verification = { ok: false, offline: true, message: String(error?.message ?? error) };
          }

          if (token) {
            if (!store || typeof store.set !== 'function') {
              return jsonResponse({ ok: false, error: t('err.credWriteUnavailable') }, 400);
            }
            await store.set(key, token);
          }
          let emailSaved = false;
          if (nextEmail !== currentEmail) {
            await writeSettings(ctx, settings, { email: nextEmail });
            emailSaved = true;
          }
          const status = await credentialStatus(ctx, settings);
          return jsonResponse({ ok: true, saved: true, tokenSaved: Boolean(token), emailSaved, verification, ...status });
        } catch (error) {
          return jsonResponse({ ok: false, error: String(error?.message ?? error) }, 400);
        }
      },
    });
  } catch (error) {
    jira.notes.push(t('note.noCredentialRouteError', { path: CREDENTIAL_PATH, message: error?.message ?? error }));
  }
}

// ------------------------------------------------------- 可改的运行时配置
//
// 「轮询开关 / 轮询间隔 / 系统通知」在 Config 里声明成了 volatile，所以能通过宿主的
// settings 服务写进**当前 profile 的 Cordis patch**（持久化），并且由 Loader 直接提交到
// 运行中的引用 —— 改完立刻生效，不用重装插件。写不进去（自定义 profile 没挂 settings /
// config-editor）时退化成「只在本次运行内生效」，并把原因回给界面。

const SETTINGS_PATH = '/api/jira-work-overview/settings';
/** 本插件在 profile 里的条目 id（= 插件包 cordis.patch.yml 里那一行的 id）。 */
const SETTINGS_NS = 'jira-work-overview';

function watchSettingsView(settings) {
  return {
    watchEnabled: liveSetting(settings, 'watchEnabled', true) !== false,
    watchIntervalMs: intervalOf(settings),
    notify: liveSetting(settings, 'notify', true) !== false,
    minIntervalMs: 15000,
    // 查询组（可改字段）：单次拉取的条数上限。
    maxResults: limitOf(settings),
    minResults: LIMIT_MIN,
    maxResultsCap: LIMIT_MAX,
    // 条数语义：0 = 不限制（取到完为止），界面据此在输入框里显示 0 而不是空。
    unlimitedResults: LIMIT_DEFAULT,
    safetyMax: SAFETY_MAX,
    maxPages: MAX_PAGES,
    // 界面语言（可改字段）：auto 跟随 DSH 的语言设置 / 浏览器语言，zh 与 en 是强制覆盖。
    language: liveSetting(settings, 'language', DEFAULTS.language),
    // 上次用来打开配置文件的编辑器 id（面板写了就回读出来标注「上次用过」）。
    preferredEditor: String(liveSetting(settings, 'preferredEditor', '') ?? ''),
  };
}

/** 把 volatile 字段写进当前 profile 的 Cordis patch。 */
async function writeSettings(ctx, settings, patch) {
  const ops = [];
  // email 与令牌绑定，也声明成了 volatile，所以能从这里一起落盘。
  if (typeof patch?.email === 'string' && patch.email.trim()) {
    ops.push({ op: 'set', path: ['email'], value: patch.email.trim() });
  }
  const language = String(unwrapValue(patch?.language) ?? '').trim().toLowerCase();
  if (language === 'auto' || language === 'zh' || language === 'en') {
    ops.push({ op: 'set', path: ['language'], value: language });
  }
  const maxResults = Number(unwrapValue(patch?.maxResults));
  // 0 是合法值（= 不限制）：不能像旧版那样用 `> 0` 把它挡掉。
  if (Number.isFinite(maxResults)) {
    ops.push({ op: 'set', path: ['maxResults'], value: normalizeLimit(maxResults) });
  }
  if (typeof patch?.watchEnabled === 'boolean') ops.push({ op: 'set', path: ['watchEnabled'], value: patch.watchEnabled });
  if (typeof patch?.notify === 'boolean') ops.push({ op: 'set', path: ['notify'], value: patch.notify });
  // 面板记住「上次用哪个编辑器打开配置文件」。空串也照常 set（而不是 unset）：
  // 这样 applied 里始终有 preferredEditor，回读/前端标注的行为一致，少一个分支。
  if (typeof patch?.preferredEditor === 'string') {
    ops.push({ op: 'set', path: ['preferredEditor'], value: patch.preferredEditor.trim() });
  }
  const interval = Number(unwrapValue(patch?.watchIntervalMs));
  if (Number.isFinite(interval) && interval > 0) {
    ops.push({ op: 'set', path: ['watchIntervalMs'], value: Math.max(15000, Math.floor(interval)) });
  }
  if (!ops.length) throw new Error(t('err.noWritableField'));
  const applied = {};
  for (const op of ops) applied[op.path[0]] = op.value;

  const service = safeService(ctx, 'settings');
  if (!service || typeof service.mutate !== 'function') {
    settings.overrides = { ...(settings.overrides ?? {}), ...applied };
    return {
      persisted: false,
      applied,
      reason: t('err.noSettingsService'),
    };
  }

  const descriptor = typeof service.describe === 'function'
    ? service.describe().find((row) => row.ns === SETTINGS_NS)
    : undefined;
  await service.mutate(SETTINGS_NS, ops, descriptor?.revision);
  // 写入已经落到 profile 的 Cordis patch；引用由 Loader 随后提交，
  // 先用覆盖值保证「保存后立刻生效」，收到 volatile-update 再清掉。
  settings.overrides = { ...(settings.overrides ?? {}), ...applied };
  return { persisted: true, applied, documentPath: typeof service.documentPath === 'string' ? service.documentPath : undefined };
}

// --------------------------------------------- 打开 cordis.patch.yml
//
// 官方的 open-in-app 走 ctx.remote.session.openWorkspacePath，Host 会用 composed filesystem
// 校验路径，落在会话工作区之外的文件一律被拒；官方推荐的 dsh-apiproxy.openPath 这个 profile
// 又没有装。所以这里自己按平台分派（和系统通知一个套路），并且只接受
// 「非空绝对路径 + 以 cordis.patch.yml 结尾」。

/**
 * 当前 profile 的 patch 文件信息。路径优先取 settings 服务的 documentPath，
 * 取不到就回退 $DSH_PROFILE_DIR（不用 node:path，正斜杠在 Windows 上也能用）。
 * 顺带把「本机装了哪些编辑器」和「上次用哪个」给面板（只给 id / label，不带启动细节）。
 */
async function patchInfo(ctx, settings) {
  const service = safeService(ctx, 'settings');
  const fromService = typeof service?.documentPath === 'string' ? service.documentPath.trim() : '';
  const patchPath = fromService || `${process.env.DSH_PROFILE_DIR || ''}/cordis.patch.yml`;
  let patchExists = false;
  try {
    const { existsSync } = await import('node:fs');
    patchExists = Boolean(patchPath) && existsSync(patchPath);
  } catch {
    patchExists = false;
  }
  const detected = await detectEditors(settings);
  return {
    patchPath,
    patchExists,
    platform: process.platform,
    canChoose: process.platform === 'darwin' || process.platform === 'win32',
    // 面板只画探测到的那几个；空数组就显示「没有探测到已安装的编辑器」。
    editors: detected.map((row) => ({ id: row.id, label: row.label })),
    preferredEditor: String(liveSetting(settings, 'preferredEditor', '') ?? ''),
  };
}

/** execFile 的 Promise 化：只关心成败，错误由回调给出。 */
function execFileAsync(execFile, file, args, options) {
  return new Promise((resolve) => {
    try {
      execFile(file, args, options ?? {}, (error) => resolve(error ?? null));
    } catch (error) {
      resolve(error);
    }
  });
}

/** 目标必须是绝对路径（`/…` 或 `C:\…`）且以 cordis.patch.yml 结尾。 */
function isPatchTarget(path) {
  const value = String(path ?? '').trim();
  if (!value.endsWith('cordis.patch.yml')) return false;
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value);
}

// --------------------------------------------- 候选编辑器（编辑器直选）
//
// 面板里的「可用编辑器」只画本机真的装了的：**探不到就不画按钮**，宁可少一个入口，
// 也不要给用户一个点下去必然报错的按钮。所以这里只做「存在性探测」，不猜、不自动装。
// 候选表一行一个编辑器：mac 是 .app 包名、win 是 where 命令 + 已知绝对路径、
// linux 是 PATH 里的命令名。launch 是给 openPatchFile 用的启动规格。

const EDITOR_CANDIDATES = [
  {
    id: 'vscode',
    label: 'VS Code',
    mac: 'Visual Studio Code.app',
    winCmd: 'code',
    winPaths: ['%LOCALAPPDATA%\\Programs\\Microsoft VS Code\\Code.exe'],
    linux: 'code',
  },
  {
    id: 'cursor',
    label: 'Cursor',
    mac: 'Cursor.app',
    winCmd: 'cursor',
    winPaths: ['%LOCALAPPDATA%\\Programs\\cursor\\Cursor.exe'],
    linux: 'cursor',
  },
  {
    id: 'windsurf',
    label: 'Windsurf',
    mac: 'Windsurf.app',
    winCmd: 'windsurf',
    winPaths: ['%LOCALAPPDATA%\\Programs\\Windsurf\\Windsurf.exe'],
    linux: 'windsurf',
  },
  {
    id: 'zed',
    label: 'Zed',
    mac: 'Zed.app',
    winCmd: '',
    winPaths: [],
    linux: 'zed',
  },
  {
    id: 'sublime',
    label: 'Sublime Text',
    mac: 'Sublime Text.app',
    winCmd: '',
    winPaths: ['%ProgramFiles%\\Sublime Text\\sublime_text.exe'],
    linux: 'subl',
  },
  // 系统自带：macOS 的 TextEdit、Windows 的 notepad；探不到就不用画。
  { id: 'textedit', label: 'TextEdit', mac: 'TextEdit.app', winCmd: '', winPaths: [], linux: '' },
  { id: 'notepad', label: 'Notepad', mac: '', winCmd: '', winPaths: [], linux: '' },
  { id: 'gedit', label: 'gedit', mac: '', winCmd: '', winPaths: [], linux: 'gedit' },
];

/** 在 PATH 里找命令（Linux 的探测：不必完美，找到即可）。 */
function findEditorOnPath(cmd, existsSync) {
  const dirs = String(process.env.PATH ?? '').split(':').filter(Boolean);
  for (const dir of dirs) {
    const guess = `${dir.replace(/[\\/]+$/, '')}/${cmd}`;
    try {
      if (existsSync(guess)) return guess;
    } catch {
      /* 单个目录不可读就跳过 */
    }
  }
  return '';
}

/** Windows：`where <cmd>` 取第一行；用 execFileSync 包 try，找不到就空串。 */
async function whereEditorCommand(cmd) {
  if (!cmd) return '';
  try {
    const { execFileSync } = await import('node:child_process');
    const out = execFileSync('where', [cmd], { encoding: 'utf8', windowsHide: true });
    return String(out).split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0] ?? '';
  } catch {
    return '';
  }
}

/** 展开 Windows 的 `%VAR%`（大小写不敏感，找不到就原样保留）。 */
function expandWindowsEnv(pattern) {
  return String(pattern ?? '').replace(/%([^%]+)%/g, (whole, name) => {
    const key = Object.keys(process.env).find((row) => row.toLowerCase() === String(name).toLowerCase());
    return key === undefined ? whole : process.env[key];
  });
}

/**
 * 探测本机的编辑器：只返回真实存在的 `[{ id, label, launch }]`。
 * 离线测试可以用 `onDetectEditors` 钩子整体替换（与 onNotify / onOpenPatch 同一套手法）。
 */
async function detectEditors(settings) {
  if (typeof settings?.onDetectEditors === 'function') {
    try {
      const list = await settings.onDetectEditors();
      return Array.isArray(list) ? list.filter((row) => row && row.id && row.label) : [];
    } catch {
      return [];
    }
  }
  let existsSync;
  try {
    ({ existsSync } = await import('node:fs'));
  } catch {
    return [];
  }
  const platform = process.platform;
  const found = [];

  if (platform === 'darwin') {
    const home = process.env.HOME || '';
    const dirs = ['/Applications', home ? `${home}/Applications` : '', '/System/Applications'].filter(Boolean);
    for (const candidate of EDITOR_CANDIDATES) {
      if (!candidate.mac) continue;
      const dir = dirs.find((row) => {
        try {
          return existsSync(`${row}/${candidate.mac}`);
        } catch {
          return false;
        }
      });
      if (dir) found.push({ id: candidate.id, label: candidate.label, launch: { kind: 'app', value: `${dir}/${candidate.mac}` } });
    }
    return found;
  }

  if (platform === 'win32') {
    for (const candidate of EDITOR_CANDIDATES) {
      if (candidate.id === 'notepad') {
        // 系统自带，直接用命令名即可（走 PATH 里的 %WINDIR%\System32）。
        found.push({ id: candidate.id, label: candidate.label, launch: { kind: 'exe', value: 'notepad.exe' } });
        continue;
      }
      if (!candidate.winCmd && !(candidate.winPaths ?? []).length) continue;
      let hit = await whereEditorCommand(candidate.winCmd);
      if (!hit) {
        for (const pattern of candidate.winPaths ?? []) {
          const expanded = expandWindowsEnv(pattern);
          try {
            if (existsSync(expanded)) { hit = expanded; break; }
          } catch {
            /* 跳过 */
          }
        }
      }
      if (hit) found.push({ id: candidate.id, label: candidate.label, launch: { kind: 'exe', value: hit } });
    }
    return found;
  }

  // Linux / 其它类 Unix：在 PATH 里找命令名。
  for (const candidate of EDITOR_CANDIDATES) {
    if (!candidate.linux) continue;
    if (findEditorOnPath(candidate.linux, existsSync)) {
      found.push({ id: candidate.id, label: candidate.label, launch: { kind: 'cmd', value: candidate.linux } });
    }
  }
  return found;
}

/**
 * 打开 patch 文件：`default` 直接打开、`reveal` 在文件管理器里定位、`choose` 让用户挑应用、
 * `app` 用探测到的某个编辑器打开、`custom` 用用户手填的应用名 / 完整路径打开。
 * `choose` 必须「发射后不等」——osascript 会一直等到用户选完应用，绝不能把 HTTP 响应挂住。
 * `app` / `custom` 都只把「应用」当**一个 argv 参数**传给系统启动器，绝不拼 shell 字符串。
 */
async function openPatchFile(settings, mode, patchPath, jira, app) {
  const target = String(patchPath ?? '').trim();
  const picked = String(mode ?? '').trim().toLowerCase();
  const appArg = app === undefined || app === null ? '' : String(app);
  if (picked !== 'default' && picked !== 'choose' && picked !== 'reveal' && picked !== 'app' && picked !== 'custom') {
    return { ok: false, error: t('err.openModeInvalid', { mode }) };
  }
  if (!isPatchTarget(target)) return { ok: false, error: t('err.patchPathUnknown') };

  // app / custom 先把「启动哪个应用」定下来（app 要校验 id 真的在本机探测结果里）。
  let launch;
  let appValue;
  if (picked === 'app') {
    const id = appArg.trim();
    const hit = (await detectEditors(settings)).find((row) => row && row.id === id);
    if (!hit) return { ok: false, error: t('err.editorUnknown', { app: id }) };
    launch = hit.launch ?? { kind: 'app', value: hit.label };
    appValue = id;
  } else if (picked === 'custom') {
    const value = appArg.trim();
    if (!value) return { ok: false, error: t('err.customAppEmpty') };
    // 控制字符（含换行）一律拒绝：它只是一个 argv 参数，不接受多行 / 隐藏字符。
    if (/[\u0000-\u001f]/.test(value)) return { ok: false, error: t('err.customAppInvalid') };
    launch = { kind: 'custom', value };
    appValue = value;
  }

  // 测试钩子：给了就代替 execFile（配置卡片里没有这一项，只给离线测试用）。
  // 第三参只对 app / custom 有值（app 传编辑器 id、custom 传应用名）；不传第三参时行为不变。
  if (typeof settings?.onOpenPatch === 'function') {
    await settings.onOpenPatch(picked, target, appValue);
    const stubbed = { ok: true, mode: picked, patchPath: target, stubbed: true };
    if (picked === 'app' || picked === 'custom') stubbed.app = appValue;
    return stubbed;
  }

  const { execFile } = await import('node:child_process');
  const platform = process.platform;

  if (picked === 'choose') {
    if (platform === 'darwin') {
      const choose = `set appFile to choose application with prompt ${appleScriptString(t('patch.choosePrompt'))}`;
      const open = 'do shell script "open -a " & quoted form of (POSIX path of appFile)'
        + ' & " " & quoted form of ' + appleScriptString(target);
      execFile('osascript', ['-e', choose, '-e', open], (error) => {
        if (!error) return;
        const message = String(error?.message ?? error);
        if (/User canceled|-128/i.test(message)) return; // 用户取消不是错误
        jira?.notes?.push(t('note.openChooseFailed', { message }));
      });
      return { ok: true, mode: 'choose', pending: true };
    }
    if (platform === 'win32') {
      execFile('rundll32.exe', ['shell32.dll,OpenAs_RunDLL', target], { windowsHide: true }, (error) => {
        if (error) jira?.notes?.push(t('note.openChooseFailed', { message: String(error?.message ?? error) }));
      });
      return { ok: true, mode: 'choose', pending: true };
    }
    return { ok: false, error: t('err.chooseUnsupported') };
  }

  let command;
  let args;
  let options;
  if (picked === 'app' || picked === 'custom') {
    const value = String(launch?.value ?? '');
    if (platform === 'darwin') {
      // macOS：`open -a <app 名或路径>`，`--` 之后才是要打开的路径。
      command = 'open';
      args = ['-a', value, '--', target];
    } else if (platform === 'win32') {
      // Windows：是真实存在的 .exe 就直接 execFile，否则交给 cmd 的 start 兜底。
      let exeExists = false;
      try {
        const { existsSync } = await import('node:fs');
        exeExists = /\.exe$/i.test(value) && existsSync(value);
      } catch {
        exeExists = false;
      }
      if (exeExists) {
        command = value;
        args = [target];
        options = { windowsHide: true };
      } else {
        command = 'cmd.exe';
        args = ['/c', 'start', '', value, target];
        options = { windowsHide: true };
      }
    } else {
      // Linux 等：候选表里给的就是命令名，直接执行。
      command = value;
      args = [target];
    }
  } else if (picked === 'reveal') {
    if (platform === 'darwin') {
      command = 'open';
      args = ['-R', target];
    } else if (platform === 'win32') {
      command = 'explorer.exe';
      args = ['/select,' + target];
      options = { windowsHide: true };
    } else {
      // Linux 等没有统一的「定位」动作，退化成打开父目录。
      const cut = target.lastIndexOf('/');
      command = 'xdg-open';
      args = [cut > 0 ? target.slice(0, cut) : '/'];
    }
  } else if (platform === 'darwin') {
    command = 'open';
    args = [target];
  } else if (platform === 'win32') {
    command = 'cmd.exe';
    args = ['/c', 'start', '', target];
    options = { windowsHide: true };
  } else {
    command = 'xdg-open';
    args = [target];
  }

  const error = await execFileAsync(execFile, command, args, options);
  if (error) {
    return { ok: false, error: t('err.openFailed', { path: target, message: String(error?.message ?? error) }) };
  }
  const opened = { ok: true, mode: picked, patchPath: target };
  if (picked === 'app' || picked === 'custom') opened.app = appValue;
  return opened;
}

function registerSettingsRoute(ctx, jira, settings) {
  const registry = safeService(ctx, 'connection')?.fetch;
  if (!registry || typeof registry.register !== 'function') {
    jira.notes.push(t('note.noSettingsRoute', { path: SETTINGS_PATH }));
    return;
  }
  try {
    registry.register({
      path: SETTINGS_PATH,
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      async fetch(request) {
        const reportedLang = new URL(request.url).searchParams.get('lang');
        rememberReportedLang(reportedLang);
        jira.useLang(reportedLang);
        try {
          if (request.method !== 'POST') {
            const service = safeService(ctx, 'settings');
            const patch = await patchInfo(ctx, settings);
            return jsonResponse({
              ok: true,
              watch: watchSettingsView(settings),
              writable: typeof service?.mutate === 'function',
              patch,
            });
          }
          const payload = await request.json().catch(() => ({}));
          // body 里出现 `open` 就以它为准：面板的「打开 cordis.patch.yml」走这条。
          if (payload && Object.prototype.hasOwnProperty.call(payload, 'open')) {
            const info = await patchInfo(ctx, settings);
            const opened = await openPatchFile(settings, payload.open, info.patchPath, jira, payload.app);
            // app 模式顺带记住「上次用过」；记偏好失败不影响这一次打开的结果。
            if (opened.ok && opened.mode === 'app' && typeof opened.app === 'string' && opened.app) {
              try {
                await writeSettings(ctx, settings, { preferredEditor: opened.app });
              } catch {
                /* 记偏好失败只是下次少个标记，不影响打开本身 */
              }
            }
            return jsonResponse(opened, opened.ok ? 200 : 400);
          }
          const result = await writeSettings(ctx, settings, payload);
          jira.watch?.reschedule?.();
          return jsonResponse({ ok: true, saved: true, ...result, watch: watchSettingsView(settings) });
        } catch (error) {
          return jsonResponse({ ok: false, error: String(error?.message ?? error) }, 400);
        }
      },
    });
  } catch (error) {
    jira.notes.push(t('note.noSettingsRouteError', { path: SETTINGS_PATH, message: error?.message ?? error }));
  }
}


function transitionTool(jira, settings) {
  return {
    name: 'jira_transition',
    description: t('tool.transition.description'),
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: t('tool.issue.key') },
        to: { type: 'string', description: t('tool.transition.to') },
        apply: { type: 'boolean', description: t('tool.transition.apply') },
      },
      required: ['key'],
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value ?? '') }] },
    timeoutMs: settings.timeoutMs,
    async execute(args, exec) {
      jira.useLang();
      const input = args && typeof args === 'object' ? args : {};
      const key = String(input.key ?? '').trim().toUpperCase();
      if (!ISSUE_KEY.test(key)) throw new Error(t('err.invalidKey', { key: input.key ?? '' }));

      const signal = exec?.signal;
      const info = await listTransitions(jira, key, signal);
      const lines = [t('transition.header', { key }), t('transition.current', { status: info.current || '—' })];

      const wanted = typeof input.to === 'string' ? input.to.trim() : '';
      if (!wanted) {
        lines.push(t('transition.available', { count: info.transitions.length }));
        for (const row of info.transitions) {
          const required = row.required.length
            ? t('transition.rowRequired', { fields: row.required.join(t('sep.list')) })
            : '';
          lines.push(t('transition.row', { id: row.id, to: row.to, required }));
        }
        lines.push('', t('transition.hintApply'));
        return lines.join('\n');
      }

      const match = matchTransition(info.transitions, wanted);
      if (!match) {
        throw new Error(t('transition.notAvailable', {
          wanted,
          key,
          list: info.transitions.map((row) => row.to).join(t('sep.list')),
        }));
      }
      if (input.apply !== true) {
        lines.push(t('transition.willApply', { id: match.id, name: match.name, to: match.to }));
        if (match.required.length) lines.push(t('transition.needsFields', { fields: match.required.join(t('sep.list')) }));
        lines.push('', t('transition.previewOnly'));
        return lines.join('\n');
      }

      const result = await applyTransition(jira, key, match.id, signal);
      return [
        t('transition.updated', { key }),
        t('transition.updatedLine', { from: info.current || '—', to: result.status, id: match.id, name: match.name }),
        `- ${jira.settings.baseUrl}/browse/${key}`,
      ].join('\n');
    },
  };
}

function myWorkTool(jira, settings) {
  return {
    name: 'jira_my_work',
    description: t('tool.myWork.description'),
    parameters: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          enum: ['open', 'sprint', 'all'],
          description: t('tool.myWork.scope'),
        },
        jql: { type: 'string', description: t('tool.myWork.jql') },
        status: { type: 'string', description: t('tool.myWork.status') },
        limit: { type: 'integer', description: t('tool.myWork.limit') },
      },
    },
    timeoutMs: settings.timeoutMs,
    output: {
      schema: { type: 'string' },
      render(_args, value) {
        return [{ type: 'text', text: String(value ?? '') }];
      },
    },
    async execute(args, exec) {
      jira.useLang();
      const input = args && typeof args === 'object' ? args : {};
      const limit = normalizeLimit(input.limit, limitOf(settings));
      const status = sanitizeStatus(input.status);
      const { jql, scope } = resolveQuery(input.scope, input.jql);
      // 和 /jira --status= 同一口径：状态条件插在 ORDER BY 之前。
      const filteredJql = applyStatus(jql, status);

      const page = await searchIssues(jira, filteredJql, limit, exec?.signal);
      return renderWorkList(page.issues, filteredJql, scope, jira, page.hasMore ? page.limit : 0);
    },
  };
}

function issueTool(jira, settings) {
  return {
    name: 'jira_issue',
    description: t('tool.issue.description'),
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: t('tool.issue.key') },
        comments: { type: 'boolean', description: t('tool.issue.comments') },
        comment_limit: { type: 'integer', description: t('tool.issue.commentLimit') },
      },
      required: ['key'],
    },
    timeoutMs: settings.timeoutMs,
    output: {
      schema: { type: 'string' },
      render(_args, value) {
        return [{ type: 'text', text: String(value ?? '') }];
      },
    },
    async execute(args, exec) {
      jira.useLang();
      const input = args && typeof args === 'object' ? args : {};
      const signal = exec?.signal;
      const key = typeof input.key === 'string' ? input.key.trim().toUpperCase() : '';
      if (!ISSUE_KEY.test(key)) {
        throw new Error(t('err.invalidKey', { key: input.key ?? '' }));
      }

      const withComments = input.comments === true;
      const fields = [...LIST_FIELDS, await resolveSprintField(jira, signal), 'description', 'created', 'components'];
      if (withComments) fields.push('comment');

      const issue = await jira.get(
        `/rest/api/3/issue/${encodeURIComponent(key)}`,
        { fields: fields.join(',') },
        signal,
      );

      return renderIssue(issue, {
        settings,
        includeComments: withComments,
        commentLimit: clampInt(input.comment_limit, 1, 50, 10),
      });
    },
  };
}

/** 看板上当前 active 的迭代。失败不影响主列表，只把原因写在结构体的 note/error 里。 */
async function fetchActiveSprint(jira, signal) {
  const boardId = jira.settings.boardId;
  if (!Number.isFinite(boardId)) return undefined;
  try {
    const body = await jira.get(`/rest/agile/1.0/board/${boardId}/sprint`, { state: 'active' }, signal);
    const sprint = Array.isArray(body?.values) ? body.values[0] : undefined;
    if (!sprint) return { boardId, active: false, note: t('sprint.none', { boardId }) };
    const late = daysSince(sprint.endDate);
    return {
      boardId,
      active: true,
      id: sprint.id ?? null,
      name: sprint.name ?? t('sprint.unnamed'),
      start: ymd(sprint.startDate),
      end: ymd(sprint.endDate),
      late,
      note: late > 0 ? t('sprint.late', { days: late }) : t('sprint.inProgress'),
    };
  } catch (error) {
    return { boardId, error: t('sprint.readFailed', { boardId, message: error?.message ?? error }) };
  }
}

function ymd(value) {
  return typeof value === 'string' && value.length >= 10 ? value.slice(0, 10) : '—';
}

/** 距今多少个整天；未来日期返回负数，非法值返回 0。 */
function daysSince(dateStr) {
  if (typeof dateStr !== 'string' || dateStr.length < 10) return 0;
  const then = Date.parse(`${dateStr.slice(0, 10)}T00:00:00`);
  const today = Date.parse(`${localYmd()}T00:00:00`);
  if (!Number.isFinite(then) || !Number.isFinite(today)) return 0;
  return Math.round((today - then) / 86400000);
}

function localYmd(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function isOverdue(dateStr) {
  return daysSince(dateStr) > 0;
}

/** 文本输出里的项目一行：列出这批 issue 真正涉及的项目（跨项目时不再假装只有一个）。 */
function projectSummary(issues, fallback) {
  const names = [];
  for (const issue of issues) {
    const name = String(issue?.key ?? '').split('-')[0];
    if (name && !names.includes(name)) names.push(name);
  }
  if (!names.length) return fallback || '—';
  return names.length === 1 ? names[0] : t('list.projectCount', { names: names.join(t('sep.list')), count: names.length });
}

function renderWorkList(issues, jql, scope, jira, limitHit) {
  const settings = jira.settings;
  const lines = [
    t('list.header', { scope: scopeLabel(scope), count: issues.length }),
    '',
    t('list.meta', {
      baseUrl: settings.baseUrl,
      project: projectSummary(issues, settings.projectKey),
      account: liveSetting(settings, 'email', '') || t('list.accountMissing'),
    }),
    t('list.credentialSource', { source: jira.tokenSource }),
  ];
  const watch = watchSnapshot(jira.watch);
  if (watch?.enabled) {
    const seconds = Math.round(watch.intervalMs / 1000);
    const seen = watch.checks ? t('watch.checked', { count: watch.checks }) : t('watch.notRun');
    const pending = watch.counts.total ? t('watch.pending', { count: watch.counts.total }) : t('watch.noPending');
    const failures = watch.failures ? t('watch.failures', { count: watch.failures, message: watch.lastError }) : '';
    lines.push(t('watch.line', { seconds, seen, pending, failures }));
    for (const change of watch.changes.slice(0, 5)) lines.push(`  - ${describeChange(change)}`);
  } else if (watch) {
    lines.push(t('watch.disabledLine'));
  }
  lines.push(t('list.jql', { jql }));
  for (const note of jira.notes) lines.push(t('list.note', { note }));

  if (!issues.length) {
    lines.push('', t('list.empty'));
    return lines.join('\n');
  }

  const groups = new Map();
  for (const issue of issues) {
    const key = issue?.fields?.status?.statusCategory?.key ?? 'unknown';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(issue);
  }

  const order = [
    ...CATEGORY_ORDER.filter((key) => groups.has(key)),
    ...[...groups.keys()].filter((key) => !CATEGORY_ORDER.includes(key)),
  ];

  for (const key of order) {
    const list = groups.get(key);
    lines.push('', `### ${categoryLabel(key)} — ${list.length}`);
    for (const issue of list) lines.push(formatIssueLine(issue));
  }

  const overdue = issues.filter((issue) => isOverdue(issue?.fields?.duedate));
  const tail = [t('list.statusCounts', { counts: countByStatus(issues) })];
  if (limitHit) {
    tail.push(t('list.hasMore', { limit: limitHit }));
  }
  if (overdue.length) {
    tail.push(t('list.overdue', {
      count: overdue.length,
      keys: overdue.map((i) => i?.key).filter(Boolean).join(t('sep.list')),
    }));
  }
  lines.push('', tail.join('　|　'));
  return lines.join('\n');
}

function formatIssueLine(issue) {
  const fields = issue?.fields ?? {};
  const parts = [`- \`${issue?.key ?? '?'}\``];
  if (fields.priority?.name) parts.push(`[${fields.priority.name}]`);
  parts.push(String(fields.summary ?? t('common.untitled')).trim());

  const extras = [];
  if (fields.status?.name) extras.push(fields.status.name);
  if (fields.issuetype?.name) extras.push(fields.issuetype.name);
  if (fields.parent?.key) extras.push(t('issue.parent', { key: fields.parent.key }));
  if (fields.duedate) {
    extras.push(t('issue.due', {
      date: fields.duedate,
      overdue: isOverdue(fields.duedate) ? t('issue.overdue') : '',
    }));
  }
  if (typeof fields.updated === 'string') extras.push(t('issue.updated', { date: fields.updated.slice(0, 10) }));
  if (extras.length) parts.push(`· ${extras.join(' · ')}`);

  return parts.join(' ');
}

function countByStatus(issues) {
  const counts = new Map();
  for (const issue of issues) {
    const name = issue?.fields?.status?.name ?? t('common.unknown');
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const entries = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return entries.map(([name, n]) => `${name} ${n}`).join(' · ') || '—';
}

/**
 * client 面板的载荷：同一次查询换成界面能直接排版的字段，避免在浏览器里解 Markdown。
 * `ok: false` 只在查询本身失败时出现（命令面的 handler 失败会走 kind:'error'）。
 */
function buildWorkListJson(issues, jql, scope, jira, sprint, page, totals) {
  const counts = { new: 0, indeterminate: 0, done: 0 };
  const ranks = page?.ranks ?? null;
  const items = issues.map((issue) => {
    const item = buildItemJson(issue, jira, ranks);
    if (Object.prototype.hasOwnProperty.call(counts, item.category)) counts[item.category] += 1;
    return item;
  });
  return {
    ok: true,
    source: 'dsh-jira-work-overview',
    generatedAt: new Date().toISOString(),
    query: { scope, jql },
    // project 保留兼容（配置里的默认项目）；projects 是这次结果里真正出现的项目。
    project: jira.settings.projectKey,
    projects: [...items.reduce((map, item) => {
      const name = item.project || '—';
      map.set(name, (map.get(name) ?? 0) + 1);
      return map;
    }, new Map())].map(([name, count]) => ({ name, count })).sort((a, b) => (b.count - a.count) || a.name.localeCompare(b.name)),
    // 界面据此显示「加载更多」：limit 是这次生效的条数上限，hasMore 说明后面还有。
    limit: page?.limit ?? limitOf(jira.settings),
    hasMore: page?.hasMore === true,
    // 准确总数（approximate-count，实测与翻页拉全集一致）；拿不到就是 null，面板不显示数字。
    total: Number.isFinite(totals?.total) ? totals.total : null,
    // 每个项目的准确总数；null 表示这次没算（项目太多或查询失败）。
    projectTotals: totals?.projectTotals ?? null,
    // 状态筛选：空串 = 全部；statusOptions 是筛选菜单的选项（模块级缓存 + 这次 items 里见到的状态）。
    status: typeof page?.status === 'string' ? page.status : '',
    statusOptions: statusOptionsOf(items),
    credentialSource: jira.tokenSource,
    notes: [...jira.notes],
    sprint: sprint ?? null,
    watch: watchSnapshot(jira.watch),
    counts: { ...counts, total: items.length },
    sprints: groupBySprint(items),
    items,
  };
}

/**
 * `--json` 失败时的载荷：字段与正常载荷同一套（列表为空），另外带 `ok:false` 与 `error{code,message}`。
 * 界面只读 `ok` / `error.code` 选提示文案，脚本也能按 code 分支 —— 两边都不必去匹配报错文案。
 */
function buildWorkListErrorJson(jira, error, { jql, scope, status, limit }) {
  return {
    ok: false,
    source: 'dsh-jira-work-overview',
    generatedAt: new Date().toISOString(),
    error: { code: errorCodeOf(error), message: String(error?.message ?? error) },
    query: { scope, jql },
    project: jira.settings.projectKey,
    projects: [],
    limit,
    hasMore: false,
    total: null,
    projectTotals: null,
    status: typeof status === 'string' ? status : '',
    statusOptions: statusOptionsOf([]),
    credentialSource: jira.tokenSource,
    notes: [...jira.notes],
    sprint: null,
    watch: watchSnapshot(jira.watch),
    counts: { new: 0, indeterminate: 0, done: 0, total: 0 },
    sprints: [],
    items: [],
  };
}

/**
 * 按 sprint 分组给界面用：按 sprint id 从新到旧，「无迭代」永远最后。
 * 刻意不按 Jira 的 sprint 状态（active/future）排序，也不打状态徽标：本 board 把 Sprint 23–29
 * 全报成 future、日期还落在过去，跟实际工作安排对不上（用户 2026-11-18 的决定）。
 * 每组自带条目数与状态分布，界面不用自己算。
 */
function groupBySprint(items) {
  const groups = new Map();
  for (const item of items) {
    const id = item.sprintId === null || item.sprintId === undefined ? null : String(item.sprintId);
    const key = id ?? 'none';
    if (!groups.has(key)) {
      groups.set(key, {
        id,
        name: item.sprint || t('sprint.backlog'),
        state: item.sprintState || '',
        start: item.sprintStart || '',
        end: item.sprintEnd || '',
        keys: [],
        counts: { new: 0, indeterminate: 0, done: 0 },
      });
    }
    const group = groups.get(key);
    group.keys.push(item.key);
    if (Object.prototype.hasOwnProperty.call(group.counts, item.category)) group.counts[item.category] += 1;
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      active: group.state === 'active',
      counts: { ...group.counts, total: group.keys.length },
    }))
    // 只按 sprint id 从新到旧排，无迭代垫底。**不用**「active 优先」：Jira 里的
    // sprint 状态（active/future）跟实际工作安排对不上（本站 Sprint 23–29 全报 future），
    // 按它排序会误导谁排在最前面。
    .sort((left, right) => {
      if ((left.id === null) !== (right.id === null)) return left.id === null ? 1 : -1;
      return Number(right.id ?? 0) - Number(left.id ?? 0);
    });
}

/** 这个优先级在站点顺序里的名次（0 = 最高级）。先按 id 命中（站点改名不影响），再按小写名字命中；都没有就是 null。 */
function priorityRankOf(priority, ranks) {
  if (!ranks || !priority) return null;
  const id = priority.id === undefined || priority.id === null ? '' : String(priority.id).trim();
  if (id && ranks.has(`id:${id}`)) return ranks.get(`id:${id}`);
  const name = String(priority.name ?? '').trim().toLowerCase();
  if (name && ranks.has(`name:${name}`)) return ranks.get(`name:${name}`);
  return null;
}

function buildItemJson(issue, jira, ranks) {
  const fields = issue?.fields ?? {};
  const key = issue?.key ?? '';
  const sprint = sprintOf(issue, jira.sprintField);
  return {
    key,
    project: key.includes('-') ? key.slice(0, key.indexOf('-')) : '',
    summary: String(fields.summary ?? '').trim(),
    status: fields.status?.name ?? '',
    category: fields.status?.statusCategory?.key ?? 'unknown',
    type: fields.issuetype?.name ?? '',
    priority: fields.priority?.name ?? '',
    // 优先级 id 与名次：名次来自 GET /rest/api/3/priority 的数组下标（0 = 最高级），
    // 面板据此上底色（见 client.js 的 priorityLevel）；拿不到名次就是 null，面板退回按名字判断。
    priorityId: fields.priority?.id === undefined || fields.priority?.id === null ? '' : String(fields.priority.id),
    priorityRank: priorityRankOf(fields.priority, ranks),
    parent: fields.parent?.key ?? '',
    due: typeof fields.duedate === 'string' ? fields.duedate.slice(0, 10) : '',
    overdue: Boolean(fields.duedate) && isOverdue(fields.duedate),
    updated: typeof fields.updated === 'string' ? fields.updated.slice(0, 10) : '',
    labels: Array.isArray(fields.labels) ? fields.labels.filter((label) => typeof label === 'string') : [],
    sprintId: sprint?.id ?? null,
    sprint: typeof sprint?.name === 'string' ? sprint.name : '',
    sprintState: typeof sprint?.state === 'string' ? sprint.state : '',
    sprintStart: typeof sprint?.startDate === 'string' ? sprint.startDate.slice(0, 10) : '',
    sprintEnd: typeof sprint?.endDate === 'string' ? sprint.endDate.slice(0, 10) : '',
    url: key ? `${jira.settings.baseUrl}/browse/${key}` : jira.settings.baseUrl,
  };
}

function buildIssueJson(issue, jira, ranks) {
  const fields = issue?.fields ?? {};
  return {
    ok: true,
    source: 'dsh-jira-work-overview',
    generatedAt: new Date().toISOString(),
    item: {
      ...buildItemJson(issue, jira, ranks),
      created: typeof fields.created === 'string' ? fields.created.slice(0, 10) : '',
      components: Array.isArray(fields.components) ? fields.components.map((c) => c?.name).filter(Boolean) : [],
      description: adfToText(fields.description).trim(),
    },
  };
}

function renderIssue(issue, options) {
  const fields = issue?.fields ?? {};
  const lines = [`# ${issue?.key ?? '?'} ${String(fields.summary ?? '').trim()}`.trim()];

  const meta = [];
  if (fields.issuetype?.name) meta.push(t('issue.meta.type', { value: fields.issuetype.name }));
  if (fields.status?.name) {
    meta.push(t('issue.meta.status', {
      value: fields.status.name,
      category: categoryLabel(fields.status?.statusCategory?.key) || t('common.unknown'),
    }));
  }
  if (fields.priority?.name) meta.push(t('issue.meta.priority', { value: fields.priority.name }));
  if (fields.assignee?.displayName) meta.push(t('issue.meta.assignee', { value: fields.assignee.displayName }));
  if (fields.reporter?.displayName) meta.push(t('issue.meta.reporter', { value: fields.reporter.displayName }));
  if (fields.parent?.key) meta.push(t('issue.meta.parent', { key: fields.parent.key }));
  if (Array.isArray(fields.components) && fields.components.length) {
    meta.push(t('issue.meta.components', { value: fields.components.map((c) => c?.name).filter(Boolean).join(', ') }));
  }
  if (Array.isArray(fields.labels) && fields.labels.length) {
    meta.push(t('issue.meta.labels', { value: fields.labels.join(', ') }));
  }
  if (fields.duedate) meta.push(t('issue.meta.due', { value: fields.duedate }));
  if (typeof fields.created === 'string') meta.push(t('issue.meta.created', { value: fields.created.slice(0, 10) }));
  if (typeof fields.updated === 'string') meta.push(t('issue.meta.updated', { value: fields.updated.replace('T', ' ').slice(0, 16) }));

  if (meta.length) lines.push('', meta.join('　·　'));
  if (issue?.key) lines.push('', t('issue.link', { url: `${options.settings.baseUrl}/browse/${issue.key}` }));

  lines.push('', t('issue.descriptionHeader'), '', adfToText(fields.description).trim() || t('issue.noDescription'));

  if (options.includeComments) {
    const all = fields.comment?.comments ?? [];
    const picked = options.commentLimit > 0 ? all.slice(-options.commentLimit) : all;
    lines.push('', t('issue.commentsHeader', { total: all.length, shown: picked.length }));
    if (!picked.length) {
      lines.push('', t('issue.noComments'));
    } else {
      for (const comment of picked) {
        const who = comment?.author?.displayName ?? t('common.unknown');
        const when = typeof comment?.created === 'string' ? comment.created.replace('T', ' ').slice(0, 16) : '';
        lines.push('', `**${who}**${when ? ` · ${when}` : ''}`, '', adfToText(comment?.body).trim() || t('issue.emptyComment'));
      }
    }
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Atlassian Document Format → 纯文本（尽力而为，保留段落、列表、标题、表格）。 */
function adfToText(node, depth = 0) {
  if (node === null || node === undefined) return '';
  if (Array.isArray(node)) return node.map((child) => adfToText(child, depth)).join('');
  if (typeof node !== 'object') return String(node);

  const type = node.type;
  if (type === 'text') return node.text ?? '';
  if (type === 'hardBreak') return '\n';
  if (type === 'mention') return node.attrs?.text ?? '@';
  if (type === 'emoji') return node.attrs?.text ?? node.attrs?.shortName ?? '';
  if (type === 'inlineCard') return node.attrs?.url ?? '';
  if (type === 'media' || type === 'mediaInline' || type === 'mediaGroup') return t('issue.attachment');
  if (type === 'rule') return '\n---\n';

  const children = Array.isArray(node.content) ? node.content : [];
  const pad = '  '.repeat(depth);
  const inner = children.map((child) => adfToText(child, depth + 1)).join('');

  switch (type) {
    case 'doc':
      return inner;
    case 'paragraph':
      return `${inner}\n`;
    case 'heading': {
      const level = Math.min(6, Math.max(1, Number(node.attrs?.level) || 1));
      return `\n${'#'.repeat(level)} ${inner.trim()}\n`;
    }
    case 'bulletList':
    case 'orderedList':
    case 'table':
    case 'tableCell':
    case 'tableHeader':
    case 'tableRow':
      return inner;
    case 'listItem': {
      const ordered = node.attrs?.order;
      const marker = Number.isFinite(Number(ordered)) ? `${ordered}.` : '-';
      return `${pad}${marker} ${inner.trim()}\n`;
    }
    case 'blockquote':
      return `${pad}> ${inner.trim()}\n`;
    case 'codeBlock':
      return `\n\`\`\`\n${inner.trim()}\n\`\`\`\n`;
    case 'panel':
      return `${pad}${inner.trim()}\n`;
    case 'panelHeader':
      return `**${inner.trim()}**\n`;
    default:
      return inner;
  }
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}
