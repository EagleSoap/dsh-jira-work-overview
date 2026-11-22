/**
 * Jira work overview —— 浏览器半边（左侧栏入口 + 浮层列表）。
 *
 * 这是「纯 JS 的 client 插件」：宿主把本文件当 bundle 直接伺服，因此不能 import
 * 任何 `@deepseek-ai/*` 客户端包（它们在安装包里不存在，只在构建产物里被内联）。
 * 只用宿主模块表里的 `react`（`react-dom` 仅用于 createPortal，取不到就退回内联定位）。
 *
 * 数据来自 host 半边的 `/jira --json [scope]` 斜杠命令：client 在自己的会话上执行它，
 * 再把 JSON 按 sprint 分组渲染。同一个操作只实现一次。
 */
window.__ModuleLoader__.load({
  // 这个 id 必须**等于包名**：host 的 client-modules 按包名物化 bundle，
  // 对不上就只报 `loaded without registering "<包名>" via __ModuleLoader__.load`，
  // 半边整个不加载（左侧栏入口 + 面板 + 配置页一起消失）。改名后忘了改这里 = 2026-11-19 的这场事故。
  id: 'dsh-jira-work-overview',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    let createPortal;
    try {
      createPortal = require('react-dom')?.createPortal;
    } catch {
      createPortal = undefined;
    }
    // 虚拟列表：`@tanstack/react-virtual` 在基座模块表里（和 react / react-dom / zustand 同级），
    // 直接 require 即可。理论上拿得到；真拿不到也不许崩 —— 退回「直接渲染全部行」并 warn 一次。
    let useVirtualizer;
    try {
      useVirtualizer = require('@tanstack/react-virtual')?.useVirtualizer;
    } catch {
      useVirtualizer = undefined;
    }
    let virtualWarned = false;
    /** 基座缺 @tanstack/react-virtual 时的替身：不做窗口裁剪，条目全给（等于旧行为）。 */
    function fallbackVirtualizer(options) {
      const count = Math.max(0, Number(options?.count) || 0);
      const size = Math.max(1, Number(options?.estimateSize?.() ?? 32) || 32);
      const items = [];
      for (let index = 0; index < count; index += 1) items.push({ index, key: index, start: index * size, size });
      return {
        getTotalSize: () => count * size,
        getVirtualItems: () => items,
        measureElement: () => undefined,
        scrollToIndex: () => undefined,
      };
    }

    const NS = 'jira-work-overview';
    const PLUGIN_ID = 'dsh-jira-work-overview';
    const CSS_ID = `${PLUGIN_ID}/client.css`;
    const ENTRY_ID = 'jira-work-overview';
    // 插件列表里那一行自己的配置页要按 "<包名>#<patch 里的 row id>" 注册（plugin-manager 的 config-ledger 就是这么找的）。
    const ROW_CONFIG_KEY = `${PLUGIN_ID}#${ENTRY_ID}`;
    const SETTINGS_PATH = '/api/jira-work-overview/settings';
    const PANEL_ID = 'jira-work-overview-panel';
    const DEFAULT_SCOPE = 'all';
    // 面板固定查「我的全部工作项」（`assignee = currentUser()`，含已完成 / 已关闭）。
    // 范围分段控件（未完成 / 全部）已去掉（用户 2026-11-18）：查询范围不再是可选项，
    // 用 tab 行右侧的状态筛选来收窄；命令行的默认范围仍是 open、后台监视仍只盯未完成
    // —— 那是 host 侧的事（SCOPE_JQL.open），通知行为一个字都不改。
    const PANEL_SCOPE = 'all';
    // 条数上限的唯一口径（和 host 侧 index.js 的 LIMIT_MIN/MAX/DEFAULT 保持一致）。
    // **0 = 不限制**：面板固定要 --limit=0（取到没有下一页为止，host 侧安全上限 5000 条 / 50 页）。
    const LIMIT_MIN = 10;
    const LIMIT_MAX = 5000;
    const LIMIT_DEFAULT = 0;
    // 虚拟列表：所有行都拍平成一维 entries 交给 @tanstack/react-virtual，只渲染视口内的行。
    // 行高估算 32px；overscan 10 行；行高真被测量（状态菜单展开、换行）时由 measureElement 回填。
    const ROW_ESTIMATE = 32;
    // 组头（标题 + 下面「迭代区间」那一行）本来就比任务行高一倍左右。估算要不分开，滚动中每量到一个
    // 组头整列就要往下窜一次（体感就是列表在抖）。估算只影响**还没被量到**的行，量过的以真实高度为准。
    const GROUP_ESTIMATE = 64;
    const ROW_OVERSCAN = 10;

    /**
     * 失败类型 → 提示文案（host 在 `--json` 载荷的 `error.code` 里给类型，见 index.js 的 JiraError）。
     * `config: true` = 「去配置」能解决，给一个直达按钮；`detail: true` = 提示之外还该看原始 message
     * （站点 / 网络给的具体原因）。表里没有的 code 一律按 unknown 处理。
     */
    const FAILURES = {
      no_credential: { title: 'failCredTitle', hint: 'failCredHint', config: true },
      credential_unreadable: { title: 'failCredUnreadableTitle', hint: 'failCredUnreadableHint', config: true, detail: true },
      no_email: { title: 'failEmailTitle', hint: 'failEmailHint', config: true },
      no_base_url: { title: 'failBaseUrlTitle', hint: 'failBaseUrlHint', config: true },
      auth: { title: 'failAuthTitle', hint: 'failAuthHint', config: true, detail: true },
      network: { title: 'failNetworkTitle', hint: 'failNetworkHint', detail: true },
      http: { title: 'failHttpTitle', hint: 'failHttpHint', detail: true },
      not_json: { title: 'failNotJsonTitle', hint: 'failNotJsonHint', detail: true },
      unknown: { title: 'failUnknownTitle', hint: 'failUnknownHint', detail: true },
    };

    function failureMeta(code) {
      return Object.prototype.hasOwnProperty.call(FAILURES, code) ? FAILURES[code] : FAILURES.unknown;
    }

    /** 条数语义的客户端归一化（与 host 侧 index.js 的 normalizeLimit 同步）：
     *  **0 = 不限制**，正数 clamp 到 10–5000，其它（非法 / 负数）回落到 fallback。 */
    function normalizeLimit(value, fallback = LIMIT_DEFAULT) {
      const n = Number(value);
      if (!Number.isFinite(n)) return fallback;
      const whole = Math.floor(n);
      if (whole === 0) return 0;
      if (whole < 0) return fallback;
      return Math.min(LIMIT_MAX, Math.max(LIMIT_MIN, whole));
    }

    const M = {
      zh: {
        title: 'Jira work overview',
        loading: '读取中…',
        empty: '没有匹配的工作项',
        refresh: '刷新',
        close: '关闭',
        retry: '重试',
        // 面板不再渲染「未完成 / 全部 / 当前迭代」——范围分段控件已去掉（用户 2026-11-18）；
        // 这三个键保留：命令行 /jira 与后台监视（host 侧 SCOPE_JQL.open）仍在用同一套范围语义。
        scopeOpen: '未完成',
        scopeSprint: '当前迭代',
        scopeAll: '全部',
        // 项目 ↔ 工作区（左栏工作区右键菜单 + 会话行角标）。
        wsLink: '关联 Jira 项目…',
        wsUnlink: '取消关联 Jira 项目',
        wsLinked: 'Jira 项目：{projects}',
        wsBoundNote: '当前工作区已关联 {projects}',
        wsShowProject: '只看 {project}',
        wsNoProjects: '没有可关联的项目：面板里先拉到过 issue 才会出现项目候选。',
        wsPickProject: '点上面的项目 tab，把它关联到当前工作区。',
        wsLinkedToast: '已把 {project} 关联到当前工作区',
        wsUnlinkedToast: '已取消 {project} 与当前工作区的关联',
        wsFailed: '关联失败：{message}',
        projectAll: '全部项目',
        scopeTotal: '共 {count} 项',
        // 状态筛选（tab 行右侧的筛选按钮）。列表本身是虚拟列表，没有「正在渲染」进度了。
        filterTitle: '筛选',
        filterAll: '全部状态',
        filterStatusPrefix: '· 状态 {name}',
        // 搜索（标题右侧的放大镜 → 输入行）：和 Jira 搜索框一致，搜整站，不只我的 issue。
        searchOpen: '搜索 Jira',
        searchPlaceholder: '搜索 Jira：摘要 / 描述 / 评论，或 issue key',
        searchHint: '回车搜索整站（不只指派给我的）；Esc 收起',
        searchClear: '清除搜索',
        searchResultPrefix: '搜索：{query}',
        searchEmpty: '没有找到匹配的 issue',
        projectTabs: '项目',
        scrollLeft: '向左滚动',
        scrollRight: '向右滚动',
        expandAll: '展开全部',
        collapseAll: '折叠全部',
        openOfTotal: '未完成 {open} / 共 {total}',
        allDone: '{total} 项全部完成',
        totalItems: '共 {total} 项',
        noSprint: '无迭代',
        // 分组维度（tab 行右侧的分段控件）与 epic 关联行
        groupBySprint: '按迭代',
        groupByEpic: '按 epic',
        epicNone: '无 epic',
        epicProjects: '{count} 个项目',
        relParent: '父任务 {key}',
        relEpic: 'epic {key}',
        relOpen: '在 Jira 打开 {key}',
        range: '{start} → {end}',
        due: '到期 {date}',
        overdue: '逾期 {date}',
        updated: '更新 {date}',
        generated: '读取于 {time}',
        credentials: '凭据 {source}',
        noChannel: '当前界面没有命令通道，无法执行 /jira。',
        noSession: '先在左侧打开一个会话：命令需要在某个会话上执行。',
        unknownCommand: '命令没有执行：/jira 未注册或语法不对。',
        commandFailed: '命令执行失败',
        // 可分类的失败（host 在 --json 载荷里给 error.code）：只显示提示 + 按钮，原始报错收进「详情」。
        failCredTitle: '还没有配置 Jira 令牌',
        failCredHint: '任务列表需要 Jira API token。点「去配置」填入账号邮箱和令牌，保存后再点「重试」。',
        failCredUnreadableTitle: '读不出凭据库里的令牌',
        failCredUnreadableHint: 'DSH 凭据库这次没有返回令牌，任务列表暂时拿不到凭据。稍后重试，或到「配置」里重新保存一次令牌。',
        failEmailTitle: '还缺账号邮箱',
        failEmailHint: 'Jira 的 Basic 认证 = 邮箱 + API token，点「去配置」补上邮箱。',
        failBaseUrlTitle: '还没有配置 Jira 站点',
        failBaseUrlHint: '在 profile 的 cordis.patch.yml 里给这一行加上 baseUrl（例如 https://your-site.atlassian.net），或在「配置」里打开 patch 文件。',
        failAuthTitle: 'Jira 不认这组邮箱 / 令牌',
        failAuthHint: '令牌可能已经过期或被撤销：到 Atlassian 账号页重新生成，再到「去配置」里换成新令牌。',
        failNetworkTitle: '连不上 Jira',
        failNetworkHint: '检查网络 / 代理，以及 baseUrl 是否写对，然后重试。',
        failHttpTitle: 'Jira 返回了错误',
        failHttpHint: '站点拒绝了这次查询，原始信息见下方。',
        failNotJsonTitle: 'Jira 返回的不是 JSON',
        failNotJsonHint: 'baseUrl 可能指到了别的站点（或代理的登录页），先确认它指向 Jira。',
        failUnknownTitle: '读取任务列表失败',
        failUnknownHint: '这次失败没有可归类的类型，原始信息见下方。',
        failOpenConfig: '去配置',
        failDetail: '原始信息：{message}',
        untitled: '（无摘要）',
        parent: '父 {key}',
        watch: '实时监视中',
        watchOff: '实时监视已关闭',
        watchUnsupported: '实时监视不可用（{reason}）',
        watchError: '实时监视断开：{message}',
        watchUnread: '{count} 项新变化',
        watchChecked: '检查于 {time}',
        markRead: '标记已读',
        changeNew: '{key} 新指派',
        changeStatus: '{key} {from} → {to}',
        changeClosed: '{key} 离开未完成列表',
        setStatus: '改状态',
        pickStatus: '选择新状态',
        statusLoading: '读取可用状态…',
        statusCurrent: '当前',
        statusCancel: '取消',
        statusChanged: '{key} 已改为 {status}',
        statusFailed: '改状态失败：{message}',
        credTitle: 'Jira 令牌',
        credGroupToken: '认证令牌',
        credGroupConnection: 'Jira 连接',
        credGroupQuery: '查询',
        credGroupWatch: '后台监视',
        fBaseUrl: '服务地址',
        fEmail: '账号邮箱',
        fProject: '项目',
        fBoard: '看板',
        fMaxResults: '每次拉取条数（0 = 不限制）',
        fTimeout: '请求超时',
        watchEnabledLabel: '开启后台监视（有新指派 / 状态变化才知道）',
        watchIntervalLabel: '检查间隔',
        watchIntervalUnit: '秒',
        watchIntervalHint: '默认 60 秒，最小 15 秒。开关和间隔都是改了就生效——立刻写入当前 profile 的 Cordis patch，下一次检查就按新值跑，不用重启 DSH。',
        notifySwitchLabel: '变化时弹系统通知（macOS / Windows）',
        watchSaving: '保存中…',
        watchSaved: '监视设置已保存（写入 profile 的 Cordis patch）。',
        watchSavedLocal: '监视设置已生效，但没能持久化：{reason}',
        watchLoadFailed: '读取监视设置失败：{message}',
        resultsLabel: '每次拉取条数',
        resultsUnit: '条',
        resultsHint: '每次拉取的条数：0 = 不限制（默认 0，一直翻页到没有下一页为止），正数范围 10–5000。面板固定按「不限制」拉取，再用虚拟列表只渲染视口内的行，所以这里不影响面板能不能显示完。',
        uiTitle: '界面',
        uiLanguageLabel: '界面语言',
        uiAuto: '自动',
        uiZh: '中文',
        uiEn: 'English',
        uiHint: '自动 = 先跟 DSH 的语言设置（设置 → 通用 → 语言），没设置时跟浏览器语言；Jira 返回的任务信息始终原样展示。改了就生效。',
        loadMore: '加载更多',
        loadedOf: '已加载 {count} 条（上限 {limit}）',
        loadedAll: '已加载 {count} 条（全部）',
        loadedCapped: '已加载 {count} 条（已达安全上限 {cap} 条，还有更多）',
        loadMoreCap: '已到上限 {cap} 条',
        loadMoreHint: '还有更多匹配的 issue（已达安全上限）；缩小 JQL 或调小查询范围再看。',
        writableOff: '这个 profile 不支持持久化配置（没有 settings 服务）',
        credSummarySet: '令牌已配置（{masked}）',
        credSummaryMissing: '还没配置 Jira 令牌',
        credCurrent: '当前令牌',
        credNotSet: '未配置',
        credSource: '来源：{source}',
        credKeyLabel: '写入位置',
        credKeyValue: 'DSH 凭据库的 {key}（位置不变）',
        credInputLabel: '新令牌',
        credEmailLabel: '账号邮箱',
        credEmailHint: '令牌和邮箱是一对（Basic 认证 = 邮箱 + 令牌）：改邮箱会连令牌一起验证，通过了才写入。',
        credPlaceholder: '粘贴新的 Jira API token',
        credSave: '保存并验证',
        credSaving: '保存中…',
        credClear: '清除令牌',
        credConfirmClear: '确认清除？',
        credSaved: '已保存到 DSH 凭据库（{key}），立即生效',
        credSavedEmail: '账号邮箱已更新为 {email}',
        credSavedOffline: '已保存到 DSH 凭据库（{key}）；这次没能验证成功（{message}）',
        credSavedAs: '已验证账号：{account}',
        credCleared: '已从凭据库删除 {key}',
        credLoadFailed: '读取令牌状态失败：{message}',
        credSaveFailed: '保存失败：{message}',
        credClearFailed: '删除失败：{message}',
        credTokensLink: '在 Atlassian 里新建 / 吊销令牌',
        credNote: '令牌只写进 DSH 凭据库，界面永远只显示打码首尾；换完立刻生效，不用重启 DSH。',
        credOther: '其余配置（baseUrl、邮箱、监视间隔等）写在 profile 的 cordis.patch.yml 里；这个页面只改令牌。',
        credOpen: '配置',
        credClose: '收起令牌设置',
        patchTitle: '配置文件',
        patchPathLabel: 'cordis.patch.yml',
        patchCopy: '复制路径',
        patchCopied: '已复制路径',
        patchCopyFailed: '复制失败，请手动选中路径',
        patchOpen: '用默认程序打开',
        patchChoose: '选择打开方式…',
        patchReveal: '在文件管理器中显示',
        patchHint: '这是当前 profile 的 Cordis patch 文件：本插件的 baseUrl / 邮箱 / 超时等配置写在这里。文件里也可能有其它插件的明文配置，注意别外发。',
        patchMissingPath: '读不到 patch 文件路径（这台机器上没有 settings 服务）。',
        patchMissingFile: '文件还不存在：写过一次配置之后它才会出现。',
        patchOpened: '已交给系统打开',
        patchChooseSent: '已弹出「打开方式」选择器，选完就会打开',
        patchRevealed: '已在文件管理器中显示',
        patchFailed: '打开失败：{message}',
        patchEditors: '可用编辑器',
        patchEditorPreferred: '（上次用过）',
        patchNoEditors: '没有探测到已安装的编辑器',
        patchCustomLabel: '用指定应用打开',
        patchCustomPlaceholder: '应用名或完整路径（例如 Code.exe）',
        patchCustomOpen: '打开',
        patchOpenedApp: '已交给 {app} 打开',
        // 任务行后面的「计划」按钮：在绑定的工作区里开一个 plan 模式会话
        planButton: '计划',
        planDrop: '删除这条计划对话（归档，卡片回到未计划）',
        planDropped: '{key} 的计划对话已删除',
        planDropFailed: '删除计划对话失败：{message}',
        planBusy: '该任务正在建计划对话…',
        planNoWorkspace: '项目 {project} 还没有绑定工作区：先在左侧侧栏里把项目挂到工作区。',
        planFailed: '创建计划对话失败：{message}',
        planCreated: '{key} 的计划对话已创建（plan 模式）',
        planOpened: '已打开 {key} 的计划对话',
        planNoSession: '工作区里没有返回新建的会话',
        planIssueLine: '任务：{key} {summary}\n链接：{url}',
        planRules: '要求：\n1. 只汇报「将要执行的修改任务」，按点列出，不写解释、背景、分析或实现细节；\n'
          + '2. 计划由用户确认或修改之后才执行，不要先动手改任何东西；\n'
          + '3. 如果这张 Jira 卡信息不全、问题不明确，不要猜也不要开始执行：直接中断，并告诉用户「Jira 任务不明确，无法进行任务」，说明缺了什么；\n'
          + '4. 有需要用户补充的信息，就在计划末尾一次问清楚；\n'
          + '5. 列完修改任务之后，必须调用一次 ask_user_question 把计划交给用户定夺（不要用纯文字问）：'
          + '问题设为「按这份计划开始执行吗？」，选项依次是「按这份计划执行」与「我要修改计划」；'
          + '用户选「我要修改计划」时，按用户填的理由改计划并重新提问，不要开始执行。',
      },
      en: {
        planButton: 'Plan',
        planDrop: 'Delete this planning session (archive it; the issue goes back to unplanned)',
        planDropped: 'Deleted the planning session for {key}',
        planDropFailed: 'Could not delete the planning session: {message}',
        planBusy: 'Creating the planning session…',
        planNoWorkspace: 'Project {project} is not linked to a workspace: link it from the sidebar first.',
        planFailed: 'Could not create the planning session: {message}',
        planCreated: 'Planning session for {key} created (plan mode)',
        planOpened: 'Opened the planning session for {key}',
        planNoSession: 'The workspace returned no new session',
        planIssueLine: 'Issue: {key} {summary}\nLink: {url}',
        planRules: 'Rules:\n1. Report only the changes you intend to make, as a bullet list; no explanation, background, analysis or implementation detail;\n'
          + '2. Do not execute anything until the user approves or edits the plan;\n'
          + '3. If this Jira issue is incomplete or the problem is unclear, do not guess and do not start: stop and tell the user the Jira issue is unclear so the task cannot proceed, and say what is missing;\n'
          + '4. Ask for anything you still need from the user, once, at the end of the plan;\n'
          + '5. After listing the changes, always call ask_user_question once to hand the plan over for a decision '
          + '(never ask in plain text): ask "Start with this plan?" with the options "Start with this plan" and '
          + '"I want to change the plan"; if the user picks the latter, revise the plan and ask again — do not start.',
        title: 'My Jira work items',
        loading: 'Loading…',
        empty: 'No matching work items',
        refresh: 'Refresh',
        close: 'Close',
        retry: 'Retry',
        // The panel no longer renders Open / All / Sprint (the scope segment is gone, 2026-11-18);
        // kept because /jira and the background watcher (host-side SCOPE_JQL.open) still use these labels.
        scopeOpen: 'Open',
        scopeSprint: 'Sprint',
        scopeAll: 'All',
        // Project ↔ workspace (workspace context menu in the sidebar + session row chips).
        wsLink: 'Link Jira project…',
        wsUnlink: 'Unlink Jira project',
        wsLinked: 'Jira projects: {projects}',
        wsBoundNote: 'This workspace is linked to {projects}',
        wsShowProject: 'Show {project} only',
        wsNoProjects: 'No projects to link yet: open the panel once so the project list loads.',
        wsPickProject: 'Click a project tab above to link it to the current workspace.',
        wsLinkedToast: 'Linked {project} to this workspace',
        wsUnlinkedToast: 'Unlinked {project} from this workspace',
        wsFailed: 'Link failed: {message}',
        projectAll: 'All projects',
        scopeTotal: '{count} items',
        // Status filter (the button at the right of the tab row) and the progressive-render hint.
        filterTitle: 'Filter',
        filterAll: 'All statuses',
        filterStatusPrefix: '· status {name}',
        // Search (the magnifier in the header → input row): same as Jira's search box, site-wide.
        searchOpen: 'Search Jira',
        searchPlaceholder: 'Search Jira: summary, description, comments, or an issue key',
        searchHint: 'Enter searches all of Jira (not just my issues); Esc closes',
        searchClear: 'Clear search',
        searchResultPrefix: 'Search: {query}',
        searchEmpty: 'No matching issues found',
        projectTabs: 'Projects',
        scrollLeft: 'Scroll left',
        scrollRight: 'Scroll right',
        expandAll: 'Expand all',
        collapseAll: 'Collapse all',
        openOfTotal: '{open} open / {total} total',
        allDone: '{total} done',
        totalItems: '{total} items',
        noSprint: 'No sprint',
        // Grouping dimension (segmented control at the right of the tab row) and the epic relation line
        groupBySprint: 'By sprint',
        groupByEpic: 'By epic',
        epicNone: 'No epic',
        epicProjects: '{count} projects',
        relParent: 'parent {key}',
        relEpic: 'epic {key}',
        relOpen: 'Open {key} in Jira',
        range: '{start} → {end}',
        due: 'due {date}',
        overdue: 'overdue {date}',
        updated: 'updated {date}',
        generated: 'read at {time}',
        credentials: 'via {source}',
        noChannel: 'No command channel in this UI: cannot run /jira.',
        noSession: 'Open a session first: the command must run on one.',
        unknownCommand: 'Command did not run: /jira unregistered or malformed.',
        commandFailed: 'Command failed',
        // Classified failures (host puts error.code into the --json payload): show a hint + a button,
        // tuck the raw message into "details".
        failCredTitle: 'No Jira token yet',
        failCredHint: 'The task list needs a Jira API token. Open "Configure", fill in your account email and token, then hit "Retry".',
        failCredUnreadableTitle: 'Could not read the stored token',
        failCredUnreadableHint: 'The DSH credential store did not return the token this time. Retry in a moment, or re-save the token under "Configure".',
        failEmailTitle: 'Account email missing',
        failEmailHint: 'Jira Basic auth is email + API token. Open "Configure" and add the email.',
        failBaseUrlTitle: 'No Jira site configured',
        failBaseUrlHint: 'Add baseUrl to this plugin\'s row in the profile\'s cordis.patch.yml (for example https://your-site.atlassian.net), or open the patch file from "Configure".',
        failAuthTitle: 'Jira rejected this email / token pair',
        failAuthHint: 'The token may be expired or revoked: generate a new one in your Atlassian account page, then replace it under "Configure".',
        failNetworkTitle: 'Cannot reach Jira',
        failNetworkHint: 'Check the network / proxy and that baseUrl is right, then retry.',
        failHttpTitle: 'Jira returned an error',
        failHttpHint: 'The site rejected this query; the raw message is below.',
        failNotJsonTitle: 'Jira did not return JSON',
        failNotJsonHint: 'baseUrl may point somewhere else (or at a proxy login page) — confirm it points at Jira.',
        failUnknownTitle: 'Could not load the task list',
        failUnknownHint: 'This failure has no known type; the raw message is below.',
        failOpenConfig: 'Configure',
        failDetail: 'Raw message: {message}',
        untitled: '(no summary)',
        parent: 'parent {key}',
        watch: 'Live watch on',
        watchOff: 'Live watch off',
        watchUnsupported: 'Live watch unavailable ({reason})',
        watchError: 'Live watch disconnected: {message}',
        watchUnread: '{count} new changes',
        watchChecked: 'checked {time}',
        markRead: 'Mark read',
        changeNew: '{key} newly assigned',
        changeStatus: '{key} {from} → {to}',
        changeClosed: '{key} left the open list',
        setStatus: 'Change status',
        pickStatus: 'Set status',
        statusLoading: 'Loading available statuses…',
        statusCurrent: 'current',
        statusCancel: 'Cancel',
        statusChanged: '{key} is now {status}',
        statusFailed: 'Status change failed: {message}',
        credTitle: 'Jira token',
        credGroupToken: 'Authentication token',
        credGroupConnection: 'Jira connection',
        credGroupQuery: 'Query',
        credGroupWatch: 'Background watch',
        fBaseUrl: 'Base URL',
        fEmail: 'Account email',
        fProject: 'Project',
        fBoard: 'Board',
        fMaxResults: 'Results per fetch (0 = unlimited)',
        fTimeout: 'Request timeout',
        watchEnabledLabel: 'Watch in the background (learn about new assignments / status changes)',
        watchIntervalLabel: 'Check every',
        watchIntervalUnit: 's',
        watchIntervalHint: 'Default 60 s, minimum 15 s. Both switches and this interval apply as soon as you change them: written straight to the active profile\'s Cordis patch, no DSH restart needed.',
        notifySwitchLabel: 'Show a system notification on changes',
        watchSaving: 'Saving…',
        watchSaved: 'Watch settings saved (written to the profile Cordis patch).',
        watchSavedLocal: 'Watch settings applied but not persisted: {reason}',
        watchLoadFailed: 'Could not read watch settings: {message}',
        resultsLabel: 'Results per fetch',
        resultsUnit: 'items',
        resultsHint: 'Items fetched per query: 0 = unlimited (the default, pages until there is no next page), a positive value ranges 10-5000. The panel always fetches with "unlimited" and renders only the rows in view via a virtual list, so this value does not limit the panel.',
        uiTitle: 'Interface',
        uiLanguageLabel: 'Language',
        uiAuto: 'Automatic',
        uiZh: '中文',
        uiEn: 'English',
        uiHint: 'Automatic follows the DSH language setting (Settings → General → Language), or your browser language when none is set. Jira-returned task data is always shown verbatim, and changes apply immediately.',
        loadMore: 'Load more',
        loadedOf: 'Loaded {count} of {limit}',
        loadedAll: 'Loaded {count} (all)',
        loadedCapped: 'Loaded {count} (safety cap {cap} reached, more available)',
        loadMoreCap: 'Reached the {cap}-item cap',
        loadMoreHint: 'More matching issues exist (the safety cap was reached); narrow the JQL or the query scope.',
        writableOff: 'This profile cannot persist configuration (no settings service)',
        credSummarySet: 'Token configured ({masked})',
        credSummaryMissing: 'No Jira token configured yet',
        credCurrent: 'Current token',
        credNotSet: 'not configured',
        credSource: 'Source: {source}',
        credKeyLabel: 'Stored at',
        credKeyValue: 'the DSH credential store key {key} (unchanged)',
        credInputLabel: 'New token',
        credEmailLabel: 'Account email',
        credEmailHint: 'The token and the email are one pair (Basic auth = email + token): changing the email re-verifies the pair before writing.',
        credPlaceholder: 'Paste a new Jira API token',
        credSave: 'Save & verify',
        credSaving: 'Saving…',
        credClear: 'Clear token',
        credConfirmClear: 'Clear it?',
        credSaved: 'Saved to the DSH credential store ({key}); effective immediately',
        credSavedEmail: 'Account email updated to {email}',
        credSavedOffline: 'Saved to the DSH credential store ({key}); verification failed this time ({message})',
        credSavedAs: 'Verified account: {account}',
        credCleared: 'Removed {key} from the credential store',
        credLoadFailed: 'Reading the token state failed: {message}',
        credSaveFailed: 'Saving failed: {message}',
        credClearFailed: 'Removing failed: {message}',
        credTokensLink: 'Create or revoke tokens at Atlassian',
        credNote: 'The token goes into the DSH credential store only, and the UI ever shows the masked head and tail; a saved token takes effect at once, no restart needed.',
        credOther: 'The rest of the configuration (baseUrl, email, watch interval…) lives in the profile\'s cordis.patch.yml; this page only changes the token.',
        credOpen: 'Configure',
        credClose: 'Hide token settings',
        patchTitle: 'Configuration file',
        patchPathLabel: 'cordis.patch.yml',
        patchCopy: 'Copy path',
        patchCopied: 'Path copied',
        patchCopyFailed: 'Copy failed — select the path manually',
        patchOpen: 'Open with default app',
        patchChoose: 'Choose an app…',
        patchReveal: 'Show in file manager',
        patchHint: 'This is the Cordis patch file of the current profile: this plugin\'s baseUrl / email / timeout settings live here. It may also contain other plugins\' plaintext configuration, so do not send it around.',
        patchMissingPath: 'The patch file path is unavailable (no settings service on this machine).',
        patchMissingFile: 'The file does not exist yet: it appears after the first write.',
        patchOpened: 'Handed over to the system',
        patchChooseSent: 'The "Open with" chooser is up — it opens once you pick an app',
        patchRevealed: 'Shown in the file manager',
        patchFailed: 'Could not open it: {message}',
        patchEditors: 'Available editors',
        patchEditorPreferred: '(used last time)',
        patchNoEditors: 'No installed editor was detected',
        patchCustomLabel: 'Open with a specific app',
        patchCustomPlaceholder: 'App name or full path (for example Code.exe)',
        patchCustomOpen: 'Open',
        patchOpenedApp: 'Handed over to {app}',
      },
    };

    // 语言只支持 zh / en；任何 tag（zh-CN、zh-Hans、en-GB…）都归一化，认不出来当英文。
    function matchLanguage(tag) {
      if (typeof tag !== 'string') return '';
      const value = tag.trim().toLowerCase();
      if (value.startsWith('zh')) return 'zh';
      if (value.startsWith('en')) return 'en';
      return '';
    }

    // 浏览器兜底：先按有序的完整语言列表（navigator.languages）找，再退回 navigator.language。
    function browserLanguage() {
      if (typeof navigator === 'undefined') return 'en';
      const tags = Array.isArray(navigator.languages) && navigator.languages.length > 0
        ? navigator.languages
        : [navigator.language];
      for (const tag of tags) {
        const hit = matchLanguage(tag);
        if (hit) return hit;
      }
      return 'en';
    }

    // 当前语言：DSH 的语言服务（设置 → 通用 → 语言）优先，拿不到才看浏览器。
    let lang = browserLanguage();
    let hostLocale;

    function currentLanguage() {
      return lang;
    }

    function setLanguage(tag) {
      const next = matchLanguage(tag);
      if (!next || next === lang) return;
      lang = next;
      // 语言换了要让面板里的文案立刻跟着换（订阅者会重渲染）。
      for (const listener of [...listeners]) listener();
    }

    function t(key, params) {
      if (hostLocale) {
        const value = hostLocale(key, params);
        if (value !== undefined && value !== null && value !== key) return String(value);
      }
      let text = M[lang][key] ?? M.zh[key] ?? key;
      if (params) {
        for (const [name, value] of Object.entries(params)) text = text.split(`{${name}}`).join(String(value));
      }
      return text;
    }

    function formatTime(value) {
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return String(value ?? '-');
      const pad = (part) => String(part).padStart(2, '0');
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }

    /* ---------------------------------------------------------------- 状态 */

    const snapshot = {
      open: false,
      credOpen: false,
      project: 'ALL',
      loading: false,
      error: '',
      /** 可分类的失败（host --json 载荷的 error 对象）：{code, message}；有它时不显示原始错误串。 */
      failure: null,
      scope: DEFAULT_SCOPE,
      data: null,
      collapsed: {},
      watch: null,
      // 条数不再进 snapshot：面板固定按「不限制」拉取，host 自己以 5000 条 / 50 页 / 30s 兜底。
      // 状态筛选（单选，空串 = 全部状态）与筛选菜单开关。
      status: '',
      filterOpen: false,
      // 搜索：输入行是否展开、输入框里还没提交的草稿、已提交并正在显示的搜索词。
      // 三者分开：改了草稿但没回车时列表不动，清除时草稿与生效词一起回到空。
      searchOpen: false,
      searchDraft: '',
      searchText: '',
      // 改状态：哪一行的下拉开着、该行读到的可用流转、正在写入的 key、一次性提示文案。
      menuKey: '',
      statuses: {},
      busyKey: '',
      flash: '',
      // 工作区（DSH 的 Workspace）：当前会话的工作区 id、面板打开时按它做过的自动预选、以及有没有自动预选过。
      // 会话 prompt 里的 @工作区 引用走的就是「会话属于某个工作区」，面板靠它把项目 tab 落到对应项目上。
      workspaceId: '',
      autoPicked: '',
      autoPickedOnce: false,
      // 用户在工作区右键菜单点了「关联 Jira 项目…」之后，正在等用户挑项目的那个工作区 id（空 = 不在挑）。
      linkTarget: '',
      // 分组维度：'sprint'（默认，按迭代）| 'epic'（按 epic 从属关系）。
      // epic 是「项目 / 任务」之外的另一条关联线：一个 epic 下的任务可以横跨多个项目与多个迭代，
      // 这正是面板要的「非线性关联」。两种视图共用同一套折叠 / 虚拟列表 / 计数逻辑。
      groupMode: 'sprint',
      // 计划对话：正在给哪条任务建计划（按钮禁用）、一次性失败提示、宿主给的 plan 模式提示词（可空）
      // （侧栏配置页的宿主配置视图里那份，见 fetchPlanPolicy）。
      planBusy: '',
      planError: '',
      planPolicy: '',
    };
    const listeners = new Set();
    const runtime = { ctx: null };

    function patch(next) {
      Object.assign(snapshot, next);
      for (const listener of [...listeners]) listener();
    }

    function useSnapshot() {
      const [value, setValue] = React.useState(snapshot);
      React.useEffect(() => {
        const update = () => setValue({ ...snapshot });
        listeners.add(update);
        update();
        return () => listeners.delete(update);
      }, []);
      return value;
    }

    /**
     * 折叠状态的键：`<模式>:<范围>:<组键>`。**模式必须进键**——sprint 与 epic 两种视图里
     * 完全可能存在同一个组键（比如 'none'），共用一条折叠状态会让两边互相串。
     */
    function collapsedKey(scope, group, mode = snapshot.groupMode === 'epic' ? 'epic' : 'sprint') {
      return `${mode}:${scope}:${group.key}`;
    }

    function groupCollapsed(scope, group) {
      const key = collapsedKey(scope, group);
      if (Object.prototype.hasOwnProperty.call(snapshot.collapsed, key)) return Boolean(snapshot.collapsed[key]);
      return group.items.length > 0 && group.items.every((item) => item.category === 'done');
    }

    function setGroupCollapsed(scope, group, value) {
      patch({ collapsed: { ...snapshot.collapsed, [collapsedKey(scope, group)]: value } });
    }

    function setAllCollapsed(scope, groups, value) {
      const next = { ...snapshot.collapsed };
      for (const group of groups) next[collapsedKey(scope, group)] = value;
      patch({ collapsed: next });
    }

    /* ------------------------------------------------------------ 数据通道 */

    function resolveCommands() {
      const ctx = runtime.ctx;
      if (!ctx) return undefined;
      const viaGet = typeof ctx.get === 'function' ? ctx.get('remote.commands') : undefined;
      return viaGet ?? ctx.remote?.commands;
    }

    function currentSessionId() {
      const ctx = runtime.ctx;
      if (!ctx) return undefined;
      const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined;
      try {
        const byId = sessions?.list?.getSnapshot?.()?.byId;
        const rows = byId && typeof byId === 'object' ? Object.values(byId) : [];
        if (rows.length === 0) return undefined;
        const main = rows.find((row) => ((row?.retainedBy?.mainView ?? 0) > 0));
        return (main ?? rows[rows.length - 1])?.id;
      } catch {
        return undefined;
      }
    }

    /* ------------------------------------------------------ 实时角标通道 */
    //
    // 不走斜杠命令：每次命令执行都会往会话里写 command/run + command/done，拿它轮询会把聊天记录刷爆。
    // 改走 host 在 connection.fetch 上注册的精确路由（GET=状态 / 长轮询，POST=标记已读）。
    // Electron 里前端是 file://，必须经壳的 transport 转发；浏览器里退回普通 fetch。

    const WATCH_PATH = '/api/jira-work-overview/state';
    const WATCH_WAIT_MS = 25000;
    // 面板里改状态走 Host 的写通道（GET 列可用流转 / POST 执行流转）。
    const TRANSITION_PATH = '/api/jira-work-overview/transition';
    // 配置页里换令牌走的通道：GET 打码状态、POST 保存/清除（Host 侧仍写同一个凭据库键）。
    const CREDENTIAL_PATH = '/api/jira-work-overview/credential';
    const TOKENS_URL = 'https://id.atlassian.com/manage-profile/security/api-tokens';
    const watch = { stopped: true, controller: null };

    /**
     * 发一个请求到角标路由。Electron 里前端跑在 file:// 上，相对路径只会打到 file:///api/…，
     * 所以优先走壳提供的 transport（它负责把 /api 请求经 IPC 桥转给 Host）；transport 没有或
     * 抛错时，再用页面自己的 fetch 试绝对地址（浏览器里 dsh web 就是这一条路）。
     */
    // host 半边的文案是它自己渲染的：每次请求都把当前语言捎过去（?lang=zh|en）。
    function withLanguage(path) {
      const value = typeof path === 'string' ? path : String(path);
      const marker = value.includes('?') ? '&' : '?';
      return `${value}${marker}lang=${encodeURIComponent(currentLanguage())}`;
    }

    async function watchFetch(path, init) {
      const url = withLanguage(path);
      const transport = typeof window !== 'undefined' ? window.__DSH_TRANSPORT__ : undefined;
      const viaTransport = typeof transport?.fetch === 'function' ? transport.fetch.bind(transport) : undefined;
      const viaFetch = typeof fetch === 'function' ? fetch.bind(globalThis) : undefined;
      const origin = typeof location !== 'undefined' && /^https?:/i.test(location?.origin ?? '') ? location.origin : '';
      const attempts = [];
      if (viaTransport) attempts.push(() => viaTransport(url, init));
      if (viaFetch) attempts.push(() => viaFetch(`${origin}${url}`, init));
      if (attempts.length === 0) throw new Error(t('watchUnsupported', { reason: 'no fetch' }));
      let last;
      for (const attempt of attempts) {
        try {
          return await attempt();
        } catch (error) {
          last = error;
        }
      }
      throw last;
    }

    function patchWatch(next) {
      const base = snapshot.watch && typeof snapshot.watch === 'object' ? snapshot.watch : {};
      patch({ watch: { ...base, ...next } });
    }

    function sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    function describeChange(change) {
      if (!change || typeof change !== 'object') return '';
      if (change.kind === 'new') return t('changeNew', { key: change.key });
      if (change.kind === 'status') {
        return t('changeStatus', { key: change.key, from: change.from ?? '—', to: change.to ?? '—' });
      }
      return t('changeClosed', { key: change.key });
    }

    async function watchLoop() {
      let failures = 0;
      while (!watch.stopped) {
        const controller = typeof AbortController === 'function' ? new AbortController() : undefined;
        watch.controller = controller;
        try {
          const response = await watchFetch(`${WATCH_PATH}?wait=${WATCH_WAIT_MS}`, {
            method: 'GET',
            headers: { accept: 'application/json' },
            signal: controller?.signal,
          });
          // 通道不存在（老宿主 / 没注册成功）就别再重试了，面板里说明一下即可。
          if (response.status === 403 || response.status === 404 || response.status === 405) {
            patchWatch({ supported: false, reason: `HTTP ${response.status}` });
            return;
          }
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const payload = await response.json();
          const incoming = payload?.watch ?? null;
          const before = snapshot.watch?.counts?.total ?? 0;
          failures = 0;
          patchWatch({ supported: true, reason: '', error: '', failures: 0, ...(incoming ?? {}) });
          const total = incoming?.counts?.total ?? 0;
          // 面板开着、且这次真的多了未读变化，就顺手把列表刷成新的。
          if (snapshot.open && before > 0 && total > before && !snapshot.loading) load(snapshot.scope);
        } catch (error) {
          if (watch.stopped || watch.controller !== controller) break;
          failures += 1;
          patchWatch({ supported: true, error: String(error?.message ?? error), failures });
          await sleep(Math.min(30000, 4000 * failures));
        }
      }
    }

    function startWatchLoop(ctx) {
      watch.stopped = false;
      const start = () => {
        void watchLoop();
      };
      const stop = () => {
        watch.stopped = true;
        watch.controller?.abort?.();
      };
      if (typeof ctx?.effect === 'function') {
        try {
          ctx.effect(() => {
            start();
            return stop;
          }, 'jira-work-overview: watch loop');
          return;
        } catch {
          /* 落到下面的直接启动 */
        }
      }
      start();
    }

    async function markWatchRead() {
      try {
        const response = await watchFetch(WATCH_PATH, { method: 'POST', headers: { accept: 'application/json' } });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json();
        patchWatch({
          supported: true,
          error: '',
          ...(payload?.watch ?? {}),
          counts: { new: 0, status: 0, closed: 0, total: 0 },
          changes: [],
        });
      } catch (error) {
        patchWatch({ error: String(error?.message ?? error) });
      }
    }

    /* ------------------------------------------------------ 改状态（写操作） */

    let flashTimer;

    /** 顶部的一次性绿色提示（例如「APP-4051 已改为 IN QA」），几秒后自己消失。 */
    function flash(text) {
      patch({ flash: text });
      if (flashTimer) clearTimeout(flashTimer);
      flashTimer = setTimeout(() => patch({ flash: '' }), 6000);
      if (flashTimer && typeof flashTimer.unref === 'function') flashTimer.unref();
    }

    function patchStatuses(key, next) {
      const base = snapshot.statuses[key] && typeof snapshot.statuses[key] === 'object' ? snapshot.statuses[key] : {};
      patch({ statuses: { ...snapshot.statuses, [key]: { ...base, ...next } } });
    }

    function toggleStatusMenu(key) {
      if (snapshot.menuKey === key) {
        patch({ menuKey: '' });
        return;
      }
      patch({ menuKey: key });
      void loadStatuses(key);
    }

    /** Jira 只允许工作流定义的流转，所以下拉列表现问 Host（GET 精确路由）。 */
    async function loadStatuses(key) {
      const cached = snapshot.statuses[key];
      if (cached?.list || cached?.loading) return;
      patchStatuses(key, { loading: true, error: '' });
      try {
        const response = await watchFetch(`${TRANSITION_PATH}?key=${encodeURIComponent(key)}`, {
          method: 'GET',
          headers: { accept: 'application/json' },
        });
        const payload = await response.json().catch(() => null);
        if (payload?.ok !== true) throw new Error(payload?.error || `HTTP ${response.status}`);
        patchStatuses(key, {
          loading: false,
          current: payload.current,
          list: Array.isArray(payload.transitions) ? payload.transitions : [],
        });
      } catch (error) {
        patchStatuses(key, { loading: false, error: t('statusFailed', { message: String(error?.message ?? error) }) });
      }
    }

    /* ------------------------------------------------- 改状态后的就地更新 */
    //
    // 改状态成功后不再全量重拉列表：一次 `/jira --json all --limit=0` 会把几百条 issue 重新翻页拉一遍，
    // 对「只变了一个状态」这件事太重。Jira 那边真正变的只有 status / statusCategory / updated，
    // 其余字段（摘要、优先级、迭代、链接）本地都已经有了，所以就地改这一行 + 重算各级计数即可。
    // 两级计数的口径与 host 的 buildWorkListJson / groupBySprint 一致：
    // counts = 按 statusCategory 分桶 + total；sprints[].counts = 该组 keys 的分桶。

    const CATEGORY_ORDER = ['new', 'indeterminate', 'done'];

    function recountItems(items) {
      const counts = { new: 0, indeterminate: 0, done: 0 };
      for (const item of items) {
        if (Object.prototype.hasOwnProperty.call(counts, item?.category)) counts[item.category] += 1;
      }
      return { ...counts, total: items.length };
    }

    /** 状态筛选菜单的选项：已见过的状态一个都不能少，新增的状态插进同一套排序（分类 → 名字）。 */
    function mergeStatusOptions(options, name, category) {
      const rows = (Array.isArray(options) ? options : [])
        .filter((row) => row && typeof row.name === 'string' && row.name)
        .map((row) => ({
          name: row.name,
          // 已有的分类以 host 为准；只有空分类才用这次回读的值补上。
          category: typeof row.category === 'string' && row.category ? row.category : '',
        }));
      if (name) {
        const hit = rows.find((row) => row.name === name);
        if (hit) {
          if (!hit.category && category) hit.category = category;
        } else {
          rows.push({ name, category: category || '' });
        }
      }
      const rank = (row) => {
        const index = CATEGORY_ORDER.indexOf(row.category);
        return index < 0 ? CATEGORY_ORDER.length : index;
      };
      return rows.sort((a, b) => (rank(a) - rank(b)) || (a.name < b.name ? -1 : (a.name > b.name ? 1 : 0)));
    }

    /** 按 items 重算每个 sprint 分组的成员与分桶（成员消失的分组直接去掉，跟 host 一致）。 */
    function recountSprints(sprints, items) {
      const byKey = new Map(items.map((item) => [item.key, item]));
      return (Array.isArray(sprints) ? sprints : [])
        .map((group) => {
          const keys = (Array.isArray(group?.keys) ? group.keys : []).filter((key) => byKey.has(key));
          return { ...group, keys, counts: recountItems(keys.map((key) => byKey.get(key))) };
        })
        .filter((group) => group.keys.length > 0);
    }

    /**
     * 把一次成功的流转合进当前载荷：只动这一行 + 各级计数。
     * 返回 false 表示当前载荷里没有这条（列表还没加载完 / 已被别处刷掉），调用方退回 load()。
     */
    function applyLocalStatus(key, status, category) {
      const data = snapshot.data;
      if (!data || !Array.isArray(data.items)) return false;
      const at = data.items.findIndex((item) => item?.key === key);
      if (at < 0) return false;
      const current = data.items[at];
      const nextStatus = status || current.status;
      const nextCategory = category || current.category || 'unknown';
      let items = data.items.map((item) => (item === current
        ? { ...item, status: nextStatus, category: nextCategory }
        : item));
      // 状态筛选开着、新状态又不再命中：跟重新查询一样，这条要从列表里消失（计数也要跟着减）。
      const filter = typeof snapshot.status === 'string' ? snapshot.status : '';
      const dropped = Boolean(filter && filter !== nextStatus);
      if (dropped) items = items.filter((item) => item.key !== key);
      const project = current.project || String(key).split('-')[0] || '';
      let projectTotals = data.projectTotals;
      if (dropped && data.projectTotals && typeof data.projectTotals === 'object') {
        projectTotals = { ...data.projectTotals };
        if (typeof projectTotals[project] === 'number') {
          projectTotals[project] = Math.max(0, projectTotals[project] - 1);
        }
      }
      patch({
        data: {
          ...data,
          items,
          counts: recountItems(items),
          sprints: recountSprints(data.sprints, items),
          statusOptions: mergeStatusOptions(data.statusOptions, nextStatus, nextCategory),
          total: dropped && typeof data.total === 'number' ? Math.max(0, data.total - 1) : data.total,
          projectTotals,
        },
      });
      return true;
    }

    async function applyStatus(key, row) {
      patch({ busyKey: key });
      patchStatuses(key, { error: '' });
      // 面板手上就有「这次流转从哪到哪、属于哪个分类」，一并发给 host：它拿这对 from/to
      // 在下一轮后台轮询里认出「这是我自己改的」，既不再弹通知，也不会往未读角标里加一条。
      const from = snapshot.statuses[key]?.current ?? '';
      try {
        const response = await watchFetch(TRANSITION_PATH, {
          method: 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify({ key, transitionId: row.id, from, to: row.to, category: row.category }),
        });
        const payload = await response.json().catch(() => null);
        if (payload?.ok !== true) throw new Error(payload?.error || `HTTP ${response.status}`);
        const status = String(payload.status ?? '').trim() || row.to || '';
        // 关下拉、清流转缓存（下次展开按新状态重新列）；列表就地更新，不再全量重拉。
        patch({ menuKey: '', busyKey: '', statuses: {} });
        flash(t('statusChanged', { key, status }));
        if (!applyLocalStatus(key, status, payload.category || row.category || '')) {
          // 极少数情况（列表还没加载 / 这条已不在当前载荷里）才退回整表刷新。
          await load(snapshot.scope);
        }
      } catch (error) {
        patchStatuses(key, { error: t('statusFailed', { message: String(error?.message ?? error) }) });
        patch({ busyKey: '' });
      }
    }

    /*
     * 切换范围时把上一次还没回来的请求作废：
     * ① 序号对不上就直接丢结果（旧响应晚到也绝不会覆盖新列表）；
     * ② 同时 abort 掉等待中的远端调用，不再白等。
     * 注意 abort 只能中断「等结果」，Host 那边已经发出的 Jira 查询没法撤回——重要的是
     * 界面只认最后一次请求的数据，切换 tab 时列表是原子替换，不会先闪一下旧范围的内容。
     */
    let loadSeq = 0;
    let loadController = null;

    function cancelLoad() {
      loadSeq += 1;
      const controller = loadController;
      loadController = null;
      if (controller) {
        try { controller.abort(); } catch { /* ignore */ }
      }
      return loadSeq;
    }

    /**
     * 面板的数据通道：范围固定 all（含已完成 / 已关闭），条数**固定 --limit=0 = 不限制**
     * ——host 会一直翻页到没有下一页，只受它自己的安全上限（5000 条 / 50 页 / 30s）约束。
     * 条数不再是面板的功能开关，所以这里不吃 limit 参数（「加载更多」只在 host 真截断时出现）。
     */
    async function load(scope) {
      const next = scope || snapshot.scope;
      const commands = resolveCommands();
      if (!commands || typeof commands.execute !== 'function') {
        cancelLoad();
        patch({ loading: false, scope: next, error: t('noChannel') });
        return;
      }
      const sessionId = currentSessionId();
      if (!sessionId) {
        cancelLoad();
        patch({ loading: false, scope: next, error: t('noSession'), failure: null });
        return;
      }
      const seq = cancelLoad();
      const controller = typeof AbortController === 'function' ? new AbortController() : undefined;
      loadController = controller;
      patch({ loading: true, error: '', failure: null, scope: next });
      try {
        // host 的 i18n 已落地：命令面也把界面语言捎过去，否则 host 渲染的文案会跟面板不一致。
        // 面板固定发 scope（all，含已完成/已关闭）；`--status=` 是单选状态筛选，空串表示不筛。
        // `--search=` 放在行尾：搜索词可能带空格，host 会一路吃到下一个 `--` 开关为止。
        const status = typeof snapshot.status === 'string' ? snapshot.status : '';
        const search = typeof snapshot.searchText === 'string' ? snapshot.searchText.trim() : '';
        const line = `/jira --json ${next} --limit=0${status ? ` --status=${status}` : ''} --lang=${currentLanguage()}${search ? ` --search=${search}` : ''}`;
        const result = await commands.execute(sessionId, line, [], controller?.signal);
        if (seq !== loadSeq) return;
        if (!result || result.ok !== true) {
          const code = result?.error?.code ?? '-';
          const message = result?.error?.message ?? '-';
          throw new Error(`${t('commandFailed')}: ${code}: ${message}`);
        }
        if (result.value === undefined) throw new Error(t('unknownCommand'));
        const outcome = result.value.result;
        if (!outcome || outcome.kind !== 'success') throw new Error(outcome?.text || t('commandFailed'));
        const data = JSON.parse(outcome.text);
        // host 在 --json 失败时不再 throw，而是回一份形状正常的 ok:false 载荷：这里只留
        // error.code / message，界面按 code 给提示，不把整句报错糊在列表位置。
        if (data && data.ok === false) {
          patch({ data: null, failure: data.error ?? { code: 'unknown', message: '' }, error: '', loading: false });
          return;
        }
        patch({ data, failure: null, error: '', loading: false });
      } catch (error) {
        if (seq !== loadSeq) return; // 被新请求取代 / 主动取消：不当成错误显示
        patch({ error: String(error?.message ?? error), failure: null, loading: false });
      } finally {
        if (loadController === controller) loadController = null;
      }
    }

    /* ------------------------------------------------ 项目 ↔ 工作区 */
    //
    // 一个 Jira 项目挂到一个工作区（工作区 = 一个项目目录），这样切到哪个工作区，
    // 面板打开时就落在哪个项目的 tab 上。映射存在 host 的 volatile 配置 projectWorkspaces 里，
    // 前端只读写、不另存一份：换机器 / 改插件都不会出现两份真相。
    const PROJECT_WORKSPACE_PATH = '/api/jira-work-overview/project-workspace';
    const workspaceLinks = { loaded: false, mapping: {}, workspaces: {} };

    function patchWorkspaceLinks(next) {
      if (!next || typeof next !== 'object') return;
      const mapping = next.mapping && typeof next.mapping === 'object' ? next.mapping : {};
      const inverted = next.workspaces && typeof next.workspaces === 'object' ? next.workspaces : {};
      workspaceLinks.mapping = mapping;
      workspaceLinks.workspaces = inverted;
      workspaceLinks.loaded = true;
      for (const listener of [...listeners]) listener();
    }

    async function fetchWorkspaceLinks(force = false) {
      if (workspaceLinks.loaded && !force) return workspaceLinks;
      try {
        const response = await watchFetch(withLanguage(`${PROJECT_WORKSPACE_PATH}?t=${Date.now()}`));
        const data = await response?.json?.().catch(() => undefined);
        if (data && data.ok !== false) patchWorkspaceLinks(data);
      } catch {
        // 通道不可用不影响面板本身：只是「按工作区自动选项目」这一步不做。
      }
      return workspaceLinks;
    }

    /* ------------------------------------------------ 任务 → 计划对话 */
    //
    // 任务行后面的「计划」按钮：在项目绑定的工作区里开一个 plan 模式会话，让它先做任务规划。
    // 一个任务只对应一个计划对话（避免重复点出好几条）：绑定记在 host 的 volatile 配置
    // planSessions 里（一行一条 `ISSUE<TAB>sessionId`），和「项目 ↔ 工作区」同一个套路——
    // 前端只读写、不另存。重复点击时直接打开原来那条，不再新建；本地没记（比如换了浏览器）
    // 就让 host 按首条消息里的标记去搜会话日志，找到就补记。
    //
    // 计划模式的**提示词归宿主管**（plan:policy 每步按宿主配置重拼），这里只在发起那一刻
    // 用 /plan 把模式定下来，再投递任务；投递走 remote.session.prompt（与聊天框同一条路，
    // 会话确实进入运行态），而不是往会话里写一条「假装用户发言」的日志。
    const PLAN_PATH = '/api/jira-work-overview/plan';
    const PLAN_TOKEN = 'JIRA_PLAN_SESSION:';
    /**
     * 这个 profile 没装 plan 模式插件时，随首条消息带过去的「计划工作方式」。
     * 装了插件（profile 里有 `@deepseek-ai/dsh-plan-mode` 且 section 非空）就用它的 section，
     * 这里只在插件缺席时兜底：计划对话是插件自己的功能，不要求用户先去 profile 里装 plan 模式。
     */
    const NO_POLICY_POLICY = '你处在 plan 模式：只做规划，不执行。只按点列出将要执行的修改任务，用户敲定后再执行。';
    const PLAN_POLL_MS = 1000;
    const PLAN_POLL_LIMIT = 20;
    const plans = { loaded: false, sessions: {} };
    const planRun = { busy: false };

    function patchPlanSessions(next) {
      if (!next || typeof next !== 'object') return;
      plans.sessions = next.sessions && typeof next.sessions === 'object' ? next.sessions : {};
      plans.loaded = true;
      for (const listener of [...listeners]) listener();
    }

    async function fetchPlanSessions(force = false) {
      if (plans.loaded && !force) return plans;
      try {
        const response = await watchFetch(withLanguage(`${PLAN_PATH}?t=${Date.now()}`));
        const data = await response?.json?.().catch(() => undefined);
        if (data && data.ok !== false) patchPlanSessions(data);
      } catch {
        // 通道不可用只会让「已绑定」显示不完整，不影响列表本身。
      }
      return plans;
    }

    async function postPlan(payload) {
      const response = await watchFetch(withLanguage(PLAN_PATH), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await response?.json?.().catch(() => undefined);
      if (!data || data.ok === false) throw new Error(data?.error || `HTTP ${response?.status ?? '-'}`);
      patchPlanSessions(data);
      return data;
    }

    /**
     * 计划模式的宿主提示词。装的是 plan 模式的默认构建：它的 `section` 留在 profile 的
     * cordis.patch.yml 里（不在 settings 覆盖页上），所以先读 settings 覆盖，再退到
     * 侧栏配置页给的那份宿主配置视图。两处都没有 → 这个 profile 没装 plan 模式插件，
     * 返回空串，由调用方兜底（plans 是插件自己的功能，不要求用户先去改 profile）。
     */
    function planPolicyText() {
      const ctx = runtime.ctx;
      const settings = ctx && typeof ctx.get === 'function' ? ctx.get('settings') : undefined;
      const read = (name) => {
        try {
          return typeof settings?.get === 'function' ? settings.get(name) : undefined;
        } catch {
          return undefined;
        }
      };
      const entry = read('deepseek-ai/dsh-plan-mode') ?? read('@deepseek-ai/dsh-plan-mode');
      const config = entry && typeof entry === 'object' ? (entry.config ?? entry) : undefined;
      if (typeof config?.section === 'string' && config.section.trim() !== '') return config.section;
      const fromUi = snapshot.planPolicy;
      return typeof fromUi === 'string' && fromUi.trim() !== '' ? fromUi : profilePlanSection();
    }

    /**
     * profile 装载时的 plan 模式 section。
     * 客户端服务表只露出 `settings` 的 `get()`；没装 plan 模式插件时它什么也不给，
     * 所以再读一次靴子数据（与面板的配置视图同源），两边都没有才算「没配」。
     */
    function profilePlanSection() {
      const boot = typeof globalThis !== 'undefined' ? globalThis.__DSH_BOOT__ : undefined;
      const rows = boot?.patch?.insert ?? boot?.insert ?? boot?.patchRows;
      if (!Array.isArray(rows)) return '';
      for (const row of rows) {
        // 行 id 是 `deepseek-ai/dsh-plan-mode`，name 是 `@deepseek-ai/dsh-plan-mode`：两种写法的都能认。
        const id = `${String(row?.id ?? '')} ${String(row?.name ?? '')}`;
        if (!id.includes('dsh-plan-mode')) continue;
        const section = row?.config?.section ?? row?.section;
        if (typeof section === 'string' && section.trim() !== '') return section;
      }
      return '';
    }

    function projectOfKey(key) {
      const text = typeof key === 'string' ? key.trim() : '';
      const dash = text.indexOf('-');
      return (dash > 0 ? text.slice(0, dash) : text).toUpperCase();
    }

    /** 项目已经绑定的工作区 id（没绑返回空串）。 */
    function boundWorkspaceOf(project) {
      for (const [workspaceId, projects] of Object.entries(workspaceLinks.workspaces)) {
        if (Array.isArray(projects) && projects.includes(project)) return workspaceId;
      }
      return '';
    }

    /** 让新建的计划对话出现在主视图：uiWorkspace 是官方的换主视图接口。 */
    function openPlanSession(sessionId) {
      const ctx = runtime.ctx;
      const uiWorkspace = ctx && typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : undefined;
      if (uiWorkspace && typeof uiWorkspace.openSession === 'function') {
        try {
          uiWorkspace.openSession(sessionId);
          return;
        } catch {
          /* 落位失败不影响已经建好的会话，侧栏里照样能看到 */
        }
      }
    }

    /** 计划对话的第一条消息：任务键、标题、链接 + 这次要按什么口径汇报。 */
    function planMessage(item, policy) {
      const lines = [`${PLAN_TOKEN}${item.key}`, '', t('planIssueLine', {
        key: item.key,
        summary: item.summary || t('untitled'),
        url: item.url || '',
      })];
      // 装了 plan 模式插件：宿主每步自己拼 plan:policy，首条消息里再放一份就是重复。
      // 没装：这里补一份兜底口径，否则会话里没有任何「只做规划」的约束。
      if (policy) lines.push('', policy);
      else lines.push('', NO_POLICY_POLICY);
      lines.push('', t('planRules'));
      return lines.join('\n');
    }

    /**
     * prompt 的 requestId 由客户端生成（Host 靠它去重：重试同一 requestId 不会投递两次）。
     * 会话里的每一次投递都必须是新值；没有 crypto.randomUUID 的老环境退回时间戳 + 随机数。
     */
    function newPlanRequestId() {
      const cryptoApi = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined;
      if (cryptoApi && typeof cryptoApi.randomUUID === 'function') return cryptoApi.randomUUID();
      return `jmw-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    }

    /**
     * 往刚建好的会话里「先 /plan 再投递任务」。
     *
     * 走会话服务而不是 remote：`sessions.using(id, …)` 拿到的是会话对象（首次会顺带打开历史，
     * 失败会抛），它的 `command()` 与 `prompt(内容, mode, signal, requestId)` 就是聊天框用的那两个方法。
     * 建会话后 agent 是异步注册的，`using` 打开历史时可能先撞上 not-found，所以整段按次数重试。
     */
    async function planSessionSend(sessionsService, sessionId, text) {
      let last;
      for (let attempt = 0; attempt < PLAN_POLL_LIMIT; attempt += 1) {
        try {
          const done = await sessionsService.using(sessionId, { source: 'mainView' }, async (reference) => {
            const session = reference?.binding?.session;
            if (!session) return false;
            if (typeof session.command === 'function') {
              const plan = await session.command('/plan');
              // 命令没被认出来（这个 profile 没装 plan 模式）也不拦：首条消息自带兜底口径。
              if (plan && plan.ok === false) return false;
            }
            const result = await session.prompt([{ type: 'text', text }], 'queue', undefined, newPlanRequestId());
            if (result && result.ok === false) throw new Error(String(result.error?.message ?? result.error?.code ?? 'prompt rejected'));
            return true;
          });
          if (done === false) last = new Error('plan command rejected');
          else return;
        } catch (error) {
          last = error;
          const code = String(error?.code ?? error?.rpcError?.code ?? '');
          if (code !== 'session/not-found' && !/not found|Session reference/i.test(String(error?.message ?? ''))) throw error;
        }
        await sleep(PLAN_POLL_MS);
      }
      throw last ?? new Error('timeout');
    }

    /**
     * 点「计划」：建/复用一条 plan 模式会话，并把任务投给它当第一条消息。
     * 成功后 host 侧已记下绑定，再点同一个任务只会打开那一条。
     */
    async function startPlan(item) {
      const key = String(item?.key ?? '').trim();
      if (!key || planRun.busy) return;
      planRun.busy = true;
      patch({ planError: '', planBusy: key });
      try {
        await fetchWorkspaceLinks();
        const project = projectOfKey(key);
        const workspaceId = boundWorkspaceOf(project);
        if (!workspaceId) throw new Error(t('planNoWorkspace', { project }));
        // 计划口径：profile 装了 plan 模式插件就用它的 section；没装时由首条消息自己带一份
        // （NO_POLICY_POLICY），不因为「宿主没配」就拒绝开对话。
        const policy = planPolicyText();

        // 前端直连要用的是「会话服务」，不是 `remote.session`：
        // remote 命名空间每个包都得自己 inject 进来才拿得到（这里根本没 inject，硬取会抛
        // `cannot get property "remote.session" without inject`）。`sessions` 是基座在客户端
        // 常驻的会话对象层（侧栏、聊天框都走它），它内部才持有 remote，并且多做三件事：
        // CATALOG 立刻更新（侧栏能看见）、新会话立刻可 retain（能落位）、prompt/command 按
        // 「Session 对象」语义发（带 requestId、回执与会话状态挂钩）。
        const sessionsService = runtime.ctx && typeof runtime.ctx.get === 'function'
          ? runtime.ctx.get('sessions')
          : undefined;
        const canCreateDirectly = Boolean(sessionsService)
          && typeof sessionsService.create === 'function'
          && typeof sessionsService.using === 'function';

        // 1) 本地绑定优先：命中就直接打开，绝不新建。
        const bound = plans.sessions[key];
        if (typeof bound === 'string' && bound) {
          openPlanSession(bound);
          flash(t('planOpened', { key }));
          return;
        }
        // 2) 本地没记：host 按首条消息里的标记搜一遍会话日志（换了浏览器 / 清过配置也能找回）。
        //    搜索只是优化，读失败不能挡住新建——那就退一步当没搜到。
        //    `force`: 本地映射里没有这张卡的记录，说明用户（或别的窗口）刚把它删掉了；
        //    这时宿主那边若还记得，可能只是它还没落盘，别把已归档的那条又翻出来。
        const found = await postPlan({ action: 'search', issue: key, force: true })
          .then((data) => data.sessionId)
          .catch(() => '');
        if (typeof found === 'string' && found) {
          openPlanSession(found);
          flash(t('planOpened', { key }));
          return;
        }
        // 3) 新建：工作区里建会话 → /plan 进计划模式 → 投递任务 → 记绑定。
        //    /plan 放在任务消息之前：会话是新的，命令当场生效；即使宿主把它排到第一次 step，
        //    也仍然在任务消息之前。
        //
        //    两条路都通：前端直接调 remote（CATALOG 会跟着更新，侧栏立刻可见、也能落位），
        //    或者交给 host 路由（首条消息由 host 现读 Jira 拼，顺带做「信息不全」检查）。
        //    选了 remote 但投递失败（比如这个版本还没有 commands 遥控）就退回 host 那条，
        //    因为 host 那边会把同一条会话重新用来接着投递。
        if (canCreateDirectly) {
          try {
            const created = await sessionsService.create({ workspaceId });
            const sessionId = created?.sessionId ?? created;
            if (!sessionId) throw new Error(t('planNoSession'));
            await postPlan({ action: 'link', issue: key, sessionId });
            openPlanSession(sessionId);
            await planSessionSend(sessionsService, sessionId, planMessage(item, policy));
            flash(t('planCreated', { key }));
            return;
          } catch (error) {
            const fallback = await postPlan({
              action: 'create',
              issue: key,
              workspaceId,
              // 不传 sessionId：让 host 现建一条。刚才那条半成品不接管，界面上也不会冒出空的闲会话。
              // skipToken 同上：前面已经搜过一次，别再按标记把刚删掉的那条翻出来。
              policy,
              instruction: planMessage(item, policy),
              skipToken: true,
            }).catch(() => undefined);
            if (!fallback?.sessionId) throw error;
            openPlanSession(fallback.sessionId);
            flash(t('planCreated', { key }));
            return;
          }
        }
        const created = await postPlan({
          action: 'create',
          issue: key,
          workspaceId,
          policy,
          instruction: planMessage(item, policy),
          // 前端那边没搜到（比如刚亲手删掉的那条），host 建会话时就别再按标记去翻一次日志：
          // 否则会撞上同一条已归档的旧会话，建也建不了、开也开不了。
          skipToken: true,
        });
        if (!created?.sessionId) throw new Error(t('planNoSession'));
        openPlanSession(created.sessionId);
        flash(t('planCreated', { key }));
      } catch (error) {
        patch({ planError: t('planFailed', { message: String(error?.message ?? error) }) });
      } finally {
        planRun.busy = false;
        patch({ planBusy: '' });
      }
    }

    /**
     * 删掉一条计划对话：交给 host 归档（与侧栏右键「归档」同一条通道），再把绑定清掉。
     * 不做「二次确认」弹窗——会话还在归档区里，误删也能从那里恢复。
     */
    async function dropPlan(item) {
      if (planRun.busy) return;
      planRun.busy = true;
      patch({ planBusy: item.key, planError: '' });
      try {
        await postPlan({ action: 'drop', issue: item.key });
        flash(t('planDropped', { key: item.key }));
      } catch (error) {
        patch({ planError: t('planDropFailed', { message: String(error?.message ?? error) }) });
      } finally {
        planRun.busy = false;
        patch({ planBusy: '' });
      }
    }

    async function mutateWorkspaceLinks(action, payload) {
      const body = { action, ...payload };
      const response = await watchFetch(withLanguage(PROJECT_WORKSPACE_PATH), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await response?.json?.().catch(() => undefined);
      if (!data || data.ok === false) throw new Error(data?.error || `HTTP ${response?.status ?? '-'}`);
      // 顺手把配置弹窗里那份 watch 视图刷新一下（映射也是 volatile 配置的一部分）。
      patchWorkspaceLinks(data);
      return data;
    }

    /** 某个工作区挂着的项目键（空格为止的第一段就是项目键）。 */
    function projectsOfWorkspace(workspaceId) {
      const ids = workspaceId ? workspaceLinks.workspaces[workspaceId] : undefined;
      return Array.isArray(ids) ? ids : [];
    }

    /** 当前会话所属的工作区（读快照；没有 sessions 服务时返回 undefined）。 */
    function currentWorkspaceView() {
      const sessionId = currentSessionId();
      if (!sessionId) return undefined;
      const ctx = runtime.ctx;
      const workspaces = ctx && typeof ctx.get === 'function' ? ctx.get('workspaces') : undefined;
      try {
        const items = workspaces?.list?.getSnapshot?.()?.items ?? [];
        return items.find((row) => Array.isArray(row?.sessionIds) && row.sessionIds.includes(sessionId));
      } catch {
        return undefined;
      }
    }

    function currentWorkspaceId() {
      return currentWorkspaceView()?.workspaceId ?? '';
    }

    /**
     * 切到工作区对应的项目 tab。只在「面板刚打开」与「用户在工作区上重新关联后」调用：
     * 映射与工作区的读取都是异步的，别在渲染里调它（否则每次重渲染都可能把 tab 抢回来）。
     */
    function adoptWorkspaceProject(force = false) {
      const workspaceId = currentWorkspaceId();
      patch({ workspaceId });
      const projects = projectsOfWorkspace(workspaceId);
      const target = projects[0] ?? '';
      patch({ autoPicked: target });
      // force = 用户刚在这个工作区上点了「关联 / 取消关联」：那是明确意图，直接落过去。
      // 否则每个会话只自动预选一次：用户之后手动切到别的 tab，重渲染不能再把 tab 抢回来。
      if (!target) return;
      if (!force && snapshot.autoPickedOnce) return;
      patch({ autoPickedOnce: true });
      // 搜索是整站范围，自动跳 tab 会把搜索结果过滤没；有搜索词时不动 tab。
      if (snapshot.searchText || snapshot.project === target) return;
      patch({ project: target, filterOpen: false, menuKey: '' });
      load(snapshot.scope);
    }

    /** 把项目挂到工作区（面板 rail 在「待关联」状态下被点中）。 */
    function linkWorkspaceProject(workspaceId, project) {
      mutateWorkspaceLinks('link', { workspaceId, project })
        .then(() => {
          void fetchPlanSessions();
          patch({ linkTarget: '', project, autoPicked: project, autoPickedOnce: true });
          flash(t('wsLinkedToast', { project }));
        })
        .catch((error) => flash(t('wsFailed', { message: String(error?.message ?? error) })));
    }

    /** 面板里那行「本工作区已关联 X」：只在自动预选/跳转过时出现（autoPicked 空串 = 本工作区没关联）。 */
    function boundProjectOfWorkspace(workspaceId) {
      if (!workspaceId) return '';
      const projects = projectsOfWorkspace(workspaceId);
      if (!projects.length) return '';
      return projects.includes(snapshot.autoPicked) ? snapshot.autoPicked : '';
    }

    /** 面板顶部那一行「工作区 ↔ 项目」说明（没有可说的就不占位置）。 */
    function renderWorkspaceNotice() {
      const state = snapshot;
      if (state.linkTarget) {
        const candidates = projectCandidates();
        return h('div', { key: 'ws-notice', className: 'jmw-ws-notice' }, [
          h('span', { key: 'text', className: 'jmw-ws-notice-text' },
            candidates.length ? t('wsPickProject') : t('wsNoProjects')),
          h('button', {
            key: 'cancel',
            type: 'button',
            className: 'jmw-linkbtn',
            onClick: () => patch({ linkTarget: '' }),
          }, t('statusCancel')),
        ]);
      }
      const bound = boundProjectOfWorkspace(state.workspaceId);
      if (!bound) return null;
      return h('div', { key: 'ws-notice', className: 'jmw-ws-notice' }, [
        h('span', { key: 'text', className: 'jmw-ws-notice-text' }, t('wsBoundNote', { projects: bound })),
        state.project === bound
          ? null
          : h('button', {
            key: 'show',
            type: 'button',
            className: 'jmw-linkbtn',
            onClick: () => patch({ project: bound, filterOpen: false, menuKey: '' }),
          }, t('wsShowProject', { project: bound })),
      ]);
    }

    /** 项目候选：面板当前数据里出现过的项目键 + 映射里已经写下的键（去重、排序、不含「全部」）。 */
    function projectCandidates() {
      const keys = new Set();
      for (const tab of projectTabs(snapshot.data)) if (tab.key !== 'ALL') keys.add(tab.key);
      for (const key of Object.keys(workspaceLinks.mapping)) keys.add(key);
      return [...keys].sort();
    }

    /* -------------------------------------------------------------- 分组 */

    function fallbackGroups(items) {
      const bySprint = new Map();
      for (const item of items) {
        const id = item.sprintId === null || item.sprintId === undefined ? 'none' : String(item.sprintId);
        if (!bySprint.has(id)) {
          bySprint.set(id, {
            id: id === 'none' ? null : id,
            name: item.sprint || t('noSprint'),
            state: item.sprintState || '',
            start: item.sprintStart || '',
            end: item.sprintEnd || '',
            keys: [],
          });
        }
        bySprint.get(id).keys.push(item.key);
      }
      // 与 host 一致：只按 sprint id 从新到旧，无迭代垫底，不看 active（它跟实际安排对不上）。
      return [...bySprint.values()].sort((left, right) => {
        if ((left.id === null) !== (right.id === null)) return left.id === null ? 1 : -1;
        return Number(right.id ?? 0) - Number(left.id ?? 0);
      });
    }

    // 结果里出现的项目（key 前缀就是项目键），按条数从多到少排；「全部」永远排第一。
    function projectTabs(data) {
      const items = Array.isArray(data?.items) ? data.items : [];
      const counts = new Map();
      for (const item of items) {
        const key = item.project || String(item.key ?? '').split('-')[0] || '—';
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      const rows = [...counts.entries()]
        .map(([key, count]) => ({ key, count }))
        .sort((a, b) => (b.count - a.count) || a.key.localeCompare(b.key));
      return [{ key: 'ALL', count: items.length }, ...rows];
    }

    // 只看某个项目时，item 上的 project（key 前缀）就是要过滤的键。
    function projectItems(data, project) {
      const items = Array.isArray(data?.items) ? data.items : [];
      if (!project || project === 'ALL') return items;
      return items.filter((item) => (item.project || String(item.key ?? '').split('-')[0]) === project);
    }

    /**
     * 按 epic 从属关系就地分组（host 的 `epics` 只按「全部项目」算过，切到单个项目时用这份重算）。
     * 与 host 的 groupByEpic 保持同形：keys + counts + projects（跨几个项目）。
     * 「无 epic」永远垫底；有 epic 的组按 epic 键升序，同一 epic 的条目仍按列表原本的顺序。
     */
    function epicGroups(items) {
      const byEpic = new Map();
      for (const item of items) {
        const key = String(item.epicKey ?? '').trim();
        const id = key || 'none';
        if (!byEpic.has(id)) {
          byEpic.set(id, {
            id: key || null,
            name: key ? (String(item.epicSummary ?? '').trim() || key) : t('epicNone'),
            projects: [],
            keys: [],
          });
        }
        const group = byEpic.get(id);
        group.keys.push(item.key);
        const project = item.project || String(item.key ?? '').split('-')[0];
        if (project && !group.projects.includes(project)) group.projects.push(project);
      }
      return [...byEpic.values()]
        .map((group) => ({ ...group, projects: group.projects.sort() }))
        .sort((left, right) => {
          if ((left.id === null) !== (right.id === null)) return left.id === null ? 1 : -1;
          return left.id === null ? 0 : String(left.id).localeCompare(String(right.id));
        });
    }

    /**
     * 把可见条目拍成组。`mode` 是分组维度：
     * - `sprint`（默认）：host 给的 sprints（看全部时）或就地重算；
     * - `epic`：按 Epic Link 从属关系，组头带 projects（跨 N 个项目）。
     * 两种模式的组形状一致（key / id / name / items / counts），下游折叠与虚拟列表不用分叉。
     */
    function buildGroups(data, project, mode = 'sprint') {
      if (!data || !Array.isArray(data.items)) return [];
      const wanted = !project || project === 'ALL' ? '' : project;
      const visible = projectItems(data, project);
      const byKey = new Map(visible.map((item) => [item.key, item]));
      // host 给的 sprints / epics 是按「全部项目」算的，切到单个项目时成员表会对不上，
      // 所以只在看「全部」时复用 host 的，否则就地从可见条目重算（字段都在 item 上）。
      const fallbackName = mode === 'epic' ? t('epicNone') : t('noSprint');
      const raw = !wanted && Array.isArray(data[mode === 'epic' ? 'epics' : 'sprints']) && data[mode === 'epic' ? 'epics' : 'sprints'].length > 0
        ? data[mode === 'epic' ? 'epics' : 'sprints']
        : (mode === 'epic' ? epicGroups(visible) : fallbackGroups(visible));
      return raw
        .map((group) => {
          const items = (group.keys ?? []).map((key) => byKey.get(key)).filter(Boolean);
          const counts = group.counts ?? {
            new: items.filter((item) => item.category === 'new').length,
            indeterminate: items.filter((item) => item.category === 'indeterminate').length,
            done: items.filter((item) => item.category === 'done').length,
            total: items.length,
          };
          return {
            key: group.id === null || group.id === undefined ? 'none' : String(group.id),
            id: group.id ?? null,
            name: group.name || fallbackName,
            state: group.state || '',
            start: group.start || '',
            end: group.end || '',
            active: Boolean(group.active) || group.state === 'active',
            // 只有 epic 组有：这组涉及的项目键（组头据此标「跨 N 个项目」）。
            projects: Array.isArray(group.projects) ? group.projects : [],
            items,
            counts,
          };
        })
        .filter((group) => group.items.length > 0);
    }

    /* -------------------------------------------------------------- 样式 */

    const CSS = `
/* 整屏遮罩只压暗，**不要加 backdrop-filter**：整窗大小的 backdrop-filter 在 macOS + Electron 上会在
   滚动重绘时让整屏闪一下（用户 2026-11-19 报的「滚动列表时屏幕闪烁」）。2px 高斯加在这层 24% 黑上
   本来就几乎看不出来，去掉没有观感损失，却拿掉了整窗合成层。 */
.jmw-mask{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:24px;
  background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.24))}
.jmw-card{display:flex;flex-direction:column;width:min(780px,100%);max-height:min(82vh,760px);overflow:hidden;
  color:var(--dsw-alias-label-primary,#1b1d22);background:var(--dsw-alias-bg-layer-2,#fff);
  border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:var(--dsw-radius-lg,16px);
  box-shadow:var(--dsw-elevation-prominent,0 18px 48px rgba(0,0,0,.24));
  font-family:var(--dsw-font-family,system-ui,-apple-system,"Segoe UI","Microsoft YaHei","PingFang SC",sans-serif);font-size:13px;line-height:1.5}
.jmw-head{display:flex;align-items:center;gap:12px;padding:16px 18px 14px}
.jmw-glyph{flex:none;width:32px;height:32px;border-radius:var(--dsw-radius-sm,8px);
  background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06));padding:2px}
.jmw-headtext{flex:1;min-width:0}
.jmw-title{font-size:15px;font-weight:600;letter-spacing:.1px}
.jmw-sub{margin-top:2px;font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8f99);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.jmw-iconbtn{flex:none;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;
  color:var(--dsw-alias-label-secondary,#5c6270);background:transparent;border:0;border-radius:var(--dsw-radius-sm,8px);cursor:pointer}
.jmw-iconbtn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06));color:var(--dsw-alias-label-primary,#1b1d22)}
.jmw-iconbtn:disabled{opacity:.4;cursor:default}
/* 搜索：放大镜平时就在标题栏原位；点开后同一位置向左展开毛玻璃输入框，失焦 / 再点收回按钮。
   展开与收起靠 .jmw-searchexpand / .jmw-searchbox 的 width 过渡（右边缘固定，所以向左长出来、
   向右收回去），图标画在框内左侧。输入框只有回车才发查询。
   毛玻璃借用 DSH 菜单 token（--dsw-menu-surface-fill / --dsw-menu-backdrop-filter），深浅主题
   自动适配；只用在这个小输入框上——整窗遮罩仍然禁止 backdrop-filter
   （0.13.3「滚动整屏闪」的成因，见 .jmw-mask 上面那条注释）。 */
.jmw-searchexpand{position:relative;flex:none;width:28px;height:28px;
  transition:width .26s cubic-bezier(.22,.61,.36,1)}
.jmw-searchexpand.open{width:min(260px,46vw)}
.jmw-searchbtn{position:absolute;right:0;top:0;z-index:1;
  transition:opacity .14s ease,background-color .14s ease,color .14s ease}
.jmw-searchexpand.open .jmw-searchbtn{opacity:0;pointer-events:none}
.jmw-searchbtn.on{color:#4d6bfe;background:rgba(77,107,254,.12)}
.jmw-searchbtn.set{color:#4d6bfe}
.jmw-searchbox{position:absolute;right:0;top:0;z-index:2;width:28px;height:28px;overflow:hidden;opacity:0;
  pointer-events:none;display:flex;align-items:center;min-width:0;border-radius:999px;
  border:1px solid rgba(128,138,158,.22);
  border-color:color-mix(in srgb,var(--dsw-alias-label-primary,#1b1d22) 13%,transparent);
  background:var(--dsw-menu-surface-fill,rgba(128,138,158,.10));
  -webkit-backdrop-filter:var(--dsw-menu-backdrop-filter,blur(10px));
  backdrop-filter:var(--dsw-menu-backdrop-filter,blur(10px));
  box-shadow:inset 0 1px 0 rgba(255,255,255,.14),0 1px 2px rgba(18,24,38,.05);
  /* 收起时先缩宽、最后才淡出（延迟 .16s），否则 .16s 就透明了，看起来像「瞬间消失」；
     展开时反过来，立刻显形。 */
  transition:width .26s cubic-bezier(.22,.61,.36,1),opacity .1s ease .16s,border-color .18s ease,box-shadow .18s ease}
.jmw-searchexpand.open .jmw-searchbox{width:100%;opacity:1;pointer-events:auto;
  transition:width .26s cubic-bezier(.22,.61,.36,1),opacity .08s ease,border-color .18s ease,box-shadow .18s ease}
.jmw-searchbox:focus-within{border-color:#4d6bfe;
  box-shadow:inset 0 1px 0 rgba(255,255,255,.14),0 0 0 2px rgba(77,107,254,.18)}
.jmw-searchicon{position:absolute;left:9px;top:50%;transform:translateY(-50%);pointer-events:none;
  color:var(--dsw-alias-label-tertiary,#8a8f99)}
.jmw-searchinput{flex:1;min-width:0;height:100%;padding:0 6px 0 30px;font:inherit;font-size:12.5px;
  color:var(--dsw-alias-label-primary,#1b1d22);background:transparent;border:0;border-radius:inherit;outline:none;
  appearance:none;-webkit-appearance:none}
.jmw-searchinput::-webkit-search-cancel-button{display:none}
.jmw-searchinput::placeholder{color:var(--dsw-alias-label-tertiary,#8a8f99)}
.jmw-searchclear{flex:none;width:22px;height:22px;margin-right:3px;padding:0;font:inherit;font-size:15px;line-height:1;cursor:pointer;
  border:0;border-radius:999px;color:var(--dsw-alias-label-tertiary,#8a8f99);background:transparent}
.jmw-searchclear:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06));color:var(--dsw-alias-label-primary,#1b1d22)}
/* 状态筛选按钮（tab 行右侧）。
   范围分段控件（.jmw-seg）和它旁边的总数（.jmw-total）连同 .jmw-bar 整行已删（用户 2026-11-18）。 */
.jmw-filterbtn{flex:none;display:inline-flex;align-items:center;gap:4px;padding:3px 9px;font:inherit;font-size:11.5px;
  cursor:pointer;border-radius:999px;white-space:nowrap;
  color:var(--dsw-alias-label-secondary,#5c6270);background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06));
  border:1px solid transparent}
.jmw-filterbtn:hover{border-color:var(--dsw-alias-border-l2,rgba(38,49,72,.18))}
.jmw-filterbtn.on{border-color:var(--dsw-alias-border-l2,rgba(38,49,72,.18))}
.jmw-filterbtn.set{color:#ffffff;background:#4d6bfe;border-color:#4d6bfe}
/* 虚拟列表（@tanstack/react-virtual）：.jmw-vlist 的高度 = getTotalSize()，每个 .jmw-vrow 用
   translateY(start) 绝对定位；DOM 里只有视口内的行 + overscan。组头 / 任务行 / 空态都是这里的一行。 */
.jmw-vlist{position:relative;width:100%}
.jmw-vrow{position:absolute;top:0;left:0;width:100%}
.jmw-linkbtn{margin-left:auto;padding:3px 8px;font:inherit;font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8f99);
  background:transparent;border:0;border-radius:6px;cursor:pointer}
.jmw-linkbtn:hover{color:var(--dsw-alias-label-primary,#1b1d22);background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}
/* 项目切换：横向滚动的 tab 条 + 左右箭头（项目多了也能翻） */
.jmw-projects{display:flex;align-items:center;gap:6px;padding:0 18px 10px}
.jmw-scrollbtn{flex:none;width:24px;height:24px;display:inline-flex;align-items:center;justify-content:center;padding:0;
  font:inherit;font-size:14px;line-height:1;cursor:pointer;border-radius:var(--dsw-radius-sm,8px);
  color:var(--dsw-alias-label-secondary,#5c6270);background:transparent;
  border:1px solid var(--dsw-alias-border-l1,rgba(38,49,72,.1))}
.jmw-scrollbtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}
.jmw-scrollbtn:disabled{opacity:.4;cursor:default}
.jmw-projectstrip{flex:1;min-width:0;display:flex;gap:6px;overflow-x:auto;scroll-behavior:smooth;padding:2px 0;scrollbar-width:thin}
.jmw-projectstrip::-webkit-scrollbar{height:5px}
.jmw-projectstrip::-webkit-scrollbar-thumb{background:var(--dsw-alias-scrollbar-bg-l2,rgba(0,0,0,.18));border-radius:3px}
.jmw-pill{flex:none;display:inline-flex;align-items:center;gap:5px;padding:3px 10px;font:inherit;font-size:11.5px;
  cursor:pointer;border-radius:999px;white-space:nowrap;
  color:var(--dsw-alias-label-secondary,#5c6270);background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06));
  border:1px solid transparent}
.jmw-pill:hover{border-color:var(--dsw-alias-border-l2,rgba(38,49,72,.18))}
.jmw-pill.on{color:#ffffff;background:#4d6bfe;border-color:#4d6bfe}
/* 分组维度（按迭代 / 按 epic）：段控，样式跟筛选按钮同一套，只多一条竖线分隔 */
.jmw-groupmode{flex:none;display:inline-flex;align-items:center;gap:2px}
.jmw-groupmode .jmw-filterbtn{border-radius:999px}
/* 从属关系行（epic / 父任务）：一行小字，带前缀箭头，点一下跳到那条任务 */
.jmw-rel{display:flex;align-items:center;gap:5px;width:100%;min-width:0;margin-top:2px;padding:0 18px 2px 44px;
  font:inherit;font-size:11px;line-height:16px;text-align:left;color:var(--dsw-alias-label-tertiary,#8a8f99);
  background:transparent;border:0;cursor:pointer;border-radius:0}
.jmw-rel:hover{color:var(--dsw-alias-brand-primary,#4d6bfe)}
.jmw-relarrow{flex:none;font-size:11px;opacity:.7}
.jmw-rellabel{flex:none;font-variant-numeric:tabular-nums;
  color:var(--dsw-alias-label-secondary,#5c6270)}
.jmw-rel:hover .jmw-rellabel{color:inherit}
.jmw-relsummary{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.85}
.jmw-rel.epic .jmw-rellabel{color:var(--dsw-alias-brand-primary,#4d6bfe);opacity:.9}
/* epic 组头右侧的「跨 N 个项目」标记 */
.jmw-epicprojects{flex:none;font-size:10.5px;line-height:16px;padding:0 6px;border-radius:999px;
  color:var(--dsw-alias-label-tertiary,#8a8f99);background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}
.jmw-body{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:6px 0 8px;
  --dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2,rgba(0,0,0,.18));
  --dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-bg-hover-l2,rgba(0,0,0,.3));scrollbar-width:thin}
.jmw-body.pending{opacity:.55}
.jmw-body{transition:opacity .12s ease}
.jmw-group{ border-top:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.04))}
.jmw-group:first-child{border-top:0}
.jmw-grouphead{display:flex;align-items:center;gap:8px;width:100%;padding:10px 18px;font:inherit;text-align:left;
  color:inherit;background:transparent;border:0;cursor:pointer}
.jmw-grouphead:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}
.jmw-chev{flex:none;width:14px;height:14px;color:var(--dsw-alias-label-tertiary,#8a8f99);transition:transform .15s ease}
.jmw-chev.open{transform:rotate(90deg)}
.jmw-sprint{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.jmw-chip{flex:none;padding:1px 7px;font-size:11px;border-radius:999px;color:var(--dsw-alias-label-secondary,#5c6270);
  border:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.12))}
.jmw-chip.live{color:var(--dsw-alias-state-success-primary,#1f8f4e);border-color:currentColor}
.jmw-count{margin-left:auto;flex:none;padding-left:10px;font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8f99)}
.jmw-count b{font-weight:600;color:var(--dsw-alias-label-secondary,#5c6270)}
.jmw-meta-line{padding:0 18px 8px 40px;font-size:11px;color:var(--dsw-alias-label-caption,var(--dsw-alias-label-tertiary,#8a8f99));
  display:flex;gap:8px;flex-wrap:wrap}
.jmw-rows{padding:0 0 4px}
.jmw-row{display:flex;align-items:center;gap:9px;padding:6px 18px 6px 40px;color:inherit;text-decoration:none;flex-wrap:wrap}
.jmw-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}
.jmw-row.open{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}
/* 高优先级整行底色：High 琥珀、Highest 红，越红越浓对比度越强；左侧竖条让色阶不靠颜色也分得清 */
.jmw-row.pri-high{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#d9a10b) 10%,transparent);
  box-shadow:inset 3px 0 0 color-mix(in srgb,var(--dsw-alias-state-warn-primary,#d9a10b) 75%,transparent)}
.jmw-row.pri-highest{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#d64545) 16%,transparent);
  box-shadow:inset 3px 0 0 var(--dsw-alias-state-error-primary,#d64545)}
.jmw-row.pri-high:hover{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#d9a10b) 17%,transparent)}
.jmw-row.pri-highest:hover{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#d64545) 24%,transparent)}
.jmw-row.pri-high.open{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#d9a10b) 20%,transparent)}
.jmw-row.pri-highest.open{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#d64545) 28%,transparent)}
/* 已完成的行弱化一档，别跟还没做的抢注意力 */
.jmw-row.done.pri-high{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#d9a10b) 5%,transparent)}
.jmw-row.done.pri-highest{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#d64545) 8%,transparent)}
.jmw-main{display:flex;align-items:center;gap:9px;flex:1;min-width:0;color:inherit;text-decoration:none}
.jmw-dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-tertiary,#8a8f99)}
.jmw-dot.new{background:var(--dsw-alias-state-idle-primary,#8a94a6)}
.jmw-dot.indeterminate{background:var(--dsw-alias-state-warn-primary,#d9a10b)}
.jmw-dot.done{background:var(--dsw-alias-state-success-primary,#2ea043)}
.jmw-key{flex:none;font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,"Cascadia Mono",monospace);font-size:12px;
  color:var(--dsw-alias-link,#4d6bfe)}
.jmw-sum{flex:1;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.jmw-row.done .jmw-sum{color:var(--dsw-alias-label-tertiary,#8a8f99)}
.jmw-rowmeta{flex:none;display:flex;align-items:center;gap:6px;font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8f99)}
.jmw-badge{padding:1px 7px;border-radius:6px;white-space:nowrap;background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06));
  color:var(--dsw-alias-label-secondary,#5c6270)}
.jmw-badge.pri{color:var(--dsw-alias-state-warn-primary,#b7791f)}
.jmw-badge.pri.highest{color:var(--dsw-alias-state-error-primary,#d64545)}
.jmw-badge.overdue{color:var(--dsw-alias-state-error-primary,#d64545);background:transparent}
.jmw-badge.quiet{background:transparent}
.jmw-badge.act{display:inline-flex;align-items:center;gap:4px;font:inherit;font-size:11px;border:1px solid transparent;cursor:pointer}
.jmw-badge.act:hover{color:var(--dsw-alias-label-primary,#1b1d22);border-color:var(--dsw-alias-border-l3,rgba(0,0,0,.12))}
.jmw-flash.err{color:var(--dsw-alias-state-error-primary,#d64545);
  background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#d64545) 10%,transparent);
  border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#d64545) 30%,transparent);
  display:flex;align-items:flex-start;gap:8px}
.jmw-flashclose{flex:none;margin-left:auto;padding:0 4px;font:inherit;font-size:14px;line-height:1;cursor:pointer;
  color:inherit;background:transparent;border:0;opacity:.7}
.jmw-flashclose:hover{opacity:1}
/* 任务行末尾的「计划」按钮：与状态 / 优先级徽标同一套视觉，但默认透明，悬停才显边框。 */
.jmw-badge.act.plan{opacity:.85}
.jmw-row:hover .jmw-badge.act.plan,.jmw-badge.act.plan.on,.jmw-badge.act.plan:focus-visible{opacity:1}
.jmw-badge.act.plan:disabled{opacity:.45;cursor:default}
.jmw-planicon{font-size:10px;line-height:1}
/* 「删掉这条计划对话」：只在已绑定时出现，弱化成一个小叉，避免和「计划」抢注意力。 */
.jmw-badge.act.plan-drop{opacity:0;padding:0 5px;font-size:11px;line-height:1;color:var(--dsw-alias-text-tertiary,rgba(0,0,0,.45))}
.jmw-row:hover .jmw-badge.act.plan-drop,.jmw-badge.act.plan-drop:focus-visible{opacity:.8}
.jmw-badge.act.plan-drop:hover{opacity:1;color:var(--dsw-alias-state-danger,rgba(200,45,45,.95))}
.jmw-badge.act.plan-drop:disabled{opacity:.3;cursor:default}
.jmw-badge.act.on{color:var(--dsw-alias-brand-primary,#4d6bfe);border-color:var(--dsw-alias-brand-primary,rgba(77,107,254,.5));
  background:var(--dsw-alias-state-info-bg,rgba(77,107,254,.08))}
.jmw-caret{font-size:9px;line-height:1;opacity:.7}
.jmw-menu{flex-basis:100%;margin:2px 0 6px;padding:8px 10px;border-radius:var(--dsw-radius-sm,8px);
  background:var(--dsw-alias-bg-layer-2,#fff);border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));
  box-shadow:0 6px 18px rgba(0,0,0,.12)}
.jmw-menu-head{display:flex;align-items:center;gap:8px;margin-bottom:6px;font-size:11px;
  color:var(--dsw-alias-label-tertiary,#8a8f99)}
.jmw-menu-head .jmw-linkbtn{margin-left:auto}
.jmw-menu-chips{display:flex;flex-wrap:wrap;gap:6px}
.jmw-menu-note{font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8f99)}
.jmw-menu-note.err{color:var(--dsw-alias-state-error-primary,#d64545)}
.jmw-cred-lang{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.jmw-cred-langlabel{flex:0 0 auto;font-size:12px;color:var(--dsw-alias-label-secondary,#5b6068)}
.jmw-cred-langchips{display:flex;gap:6px;flex-wrap:wrap}
.jmw-chip.pick{padding:3px 9px;font:inherit;font-size:11px;background:transparent;border:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.12));
  border-radius:999px;cursor:pointer}
.jmw-chip.pick:hover:not(:disabled){color:var(--dsw-alias-label-primary,#1b1d22);
  border-color:var(--dsw-alias-brand-primary,rgba(77,107,254,.6));background:var(--dsw-alias-state-info-bg,rgba(77,107,254,.08))}
.jmw-chip.pick:disabled{opacity:.55;cursor:default}
.jmw-chip.pick.cur{color:var(--dsw-alias-state-success-primary,#1f8f4e);border-color:currentColor;opacity:1}
.jmw-chip.pick.done:not(.cur){color:var(--dsw-alias-label-tertiary,#8a8f99)}
.jmw-flash{margin:0 18px 10px;padding:8px 12px;font-size:12px;border-radius:var(--dsw-radius-sm,8px);
  color:var(--dsw-alias-state-success-primary,#1f8f4e);
  background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#1f8f4e) 10%,transparent);
  border:1px solid color-mix(in srgb,var(--dsw-alias-state-success-primary,#1f8f4e) 30%,transparent)}
.jmw-state{padding:34px 18px;text-align:center;color:var(--dsw-alias-label-tertiary,#8a8f99);font-size:12px}
.jmw-state.err{color:var(--dsw-alias-label-primary,#1b1d22)}
.jmw-state .msg{margin-bottom:12px;white-space:pre-wrap;word-break:break-word}
/* 可分类的失败（没配令牌 / 站点 / 网络…）：一句「怎么办」+ 按钮，原始报错只在需要时以小字附上。 */
.jmw-failure{padding-top:40px}
.jmw-failure-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#1b1d22);margin-bottom:6px}
.jmw-failure-hint{max-width:320px;margin:0 auto 14px;line-height:1.6;color:var(--dsw-alias-label-secondary,#5c6270)}
.jmw-failure-actions{display:flex;justify-content:center;gap:8px}
.jmw-failure-detail{max-width:360px;margin:14px auto 0;font-size:11px;line-height:1.5;
  color:var(--dsw-alias-label-tertiary,#8a8f99);white-space:pre-wrap;word-break:break-word}
.jmw-btn{padding:5px 14px;font:inherit;font-size:12px;color:var(--dsw-alias-label-primary,#1b1d22);cursor:pointer;
  background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06));border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));
  border-radius:var(--dsw-radius-sm,8px)}
.jmw-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.1))}
.jmw-btn.primary{color:#fff;background:var(--dsw-alias-brand-primary,#4d6bfe);border-color:transparent}
.jmw-btn.primary:hover{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4d6bfe) 86%,#000)}
.jmw-skel{height:13px;margin:12px 40px;border-radius:7px;
  background:linear-gradient(90deg,transparent,var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.08)),transparent);
  background-size:220px 100%;animation:jmw-pulse 1.1s ease-in-out infinite}
@keyframes jmw-pulse{0%{background-position:-220px 0}100%{background-position:calc(100% + 220px) 0}}
.jmw-spin{flex:none;width:13px;height:13px;border-radius:50%;border:2px solid var(--dsw-alias-border-l3,rgba(0,0,0,.12));
  border-top-color:var(--dsw-alias-brand-primary,#4d6bfe);animation:jmw-rotate .7s linear infinite}
@keyframes jmw-rotate{to{transform:rotate(360deg)}}
.jmw-foot{display:flex;gap:12px;flex-wrap:wrap;padding:9px 18px;font-size:11px;
  color:var(--dsw-alias-label-tertiary,#8a8f99);border-top:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.04))}
.jmw-foot .warn{color:var(--dsw-alias-state-warn-primary,#b7791f)}
.jmw-more{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:2px 18px 8px}
.jmw-morehint{font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8f99)}
.jmw-watch{display:flex;align-items:center;gap:12px;margin:0 18px 10px;padding:9px 12px;font-size:12px;
  color:var(--dsw-alias-label-primary,#1b1d22);border-radius:var(--dsw-radius-sm,8px);
  background:var(--dsw-alias-state-info-bg,rgba(77,107,254,.08));
  border:1px solid var(--dsw-alias-state-info-primary,rgba(77,107,254,.28))}
.jmw-watch-text{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}
.jmw-watch-text span{font-size:11px;color:var(--dsw-alias-label-secondary,#5c6270);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.jmw-entry-badge{flex:none;min-width:18px;height:18px;padding:0 5px;font-size:11px;line-height:18px;text-align:center;
  border-radius:9px;color:#fff;background:var(--dsw-alias-state-error-primary,#d64545)}
.jmw-entry{display:flex;align-items:center;gap:8px;width:100%;padding:7px 10px;font:inherit;font-size:13px;
  color:var(--dsw-alias-label-secondary,#5c6270);background:transparent;border:0;border-radius:var(--dsw-radius-sm,8px);
  cursor:pointer;text-align:left}
.jmw-entry:hover{color:var(--dsw-alias-label-primary,#1b1d22);background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}
.jmw-entry.narrow{width:auto;justify-content:center;padding:7px}
.jmw-entry svg{flex:none}
.jmw-entry-label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.jmw-cred{display:flex;flex-direction:column;gap:8px;padding:14px 2px 4px;font-size:13px;
  color:var(--dsw-alias-label-primary,#1b1d22)}
.jmw-cred-title{margin:0;font-size:13px;font-weight:600}
/* 配置项按功能分组：每组一个标题 + 一段内容（标题清晰、内容留白一致） */
.jmw-cred-group{display:flex;flex-direction:column;gap:8px;padding:11px 13px;border-radius:var(--dsw-radius-md,12px);
  background:var(--dsw-alias-bg-layer-1,rgba(38,49,72,.03));border:1px solid var(--dsw-alias-border-l1,rgba(38,49,72,.08))}
.jmw-cred-grouptitle{margin:0;font-size:12px;font-weight:600;letter-spacing:.2px;color:var(--dsw-alias-label-primary,#1b1d22)}
.jmw-cred-groupbody{display:flex;flex-direction:column;gap:8px}
.jmw-cred-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.jmw-cred-label{font-size:12px;color:var(--dsw-alias-label-secondary,#5c6270);flex:none}
.jmw-cred-pair{display:flex;gap:10px;align-items:baseline;font-size:12px;line-height:1.6}
.jmw-cred-pair .jmw-cred-label{min-width:88px}
.jmw-cred-value{color:var(--dsw-alias-label-primary,#1b1d22);word-break:break-all}
.jmw-cred-path{font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,"Cascadia Mono",monospace);
  font-size:11.5px;line-height:1.6;color:var(--dsw-alias-label-secondary,#5b6070);word-break:break-all;
  background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06));border-radius:6px;padding:3px 7px;flex:1 1 auto}
.jmw-cred-masked{font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,"Cascadia Mono",monospace);font-size:12px;
  padding:3px 8px;border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-layer-2,rgba(38,49,72,.06));
  border:1px solid var(--dsw-alias-border-l1,rgba(38,49,72,.12));letter-spacing:.4px}
.jmw-cred-none{font-size:12px;color:var(--dsw-alias-state-warn-primary,#d9a10b)}
.jmw-cred-note{font-size:11.5px;line-height:1.6;color:var(--dsw-alias-label-tertiary,#8a90a0)}
/* 小字说明：字段下面那一行浅色提示 */
.jmw-cred-hint{margin-top:-2px;font-size:11.5px;line-height:1.6;color:var(--dsw-alias-label-tertiary,#8a90a0)}
.jmw-cred-hint.warn{color:var(--dsw-alias-state-warn-primary,#d9a10b)}
.jmw-cred-form{display:flex;flex-direction:column;gap:6px}
.jmw-cred-input,.jmw-cred-email{width:100%;max-width:420px;min-height:32px;padding:6px 10px;font:inherit;font-size:12.5px;
  color:var(--dsw-alias-label-primary,#1b1d22);background:var(--dsw-alias-bg-layer-2,#fff);
  border:1px solid var(--dsw-alias-border-l2,rgba(38,49,72,.18));border-radius:var(--dsw-radius-sm,8px)}
.jmw-cred-input:focus,.jmw-cred-email:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#4d6bfe);
  box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-brand-primary,#4d6bfe) 22%,transparent)}
.jmw-cred-num{width:96px;max-width:96px;text-align:right}
.jmw-cred-unit{font-size:12px;color:var(--dsw-alias-label-secondary,#5c6270)}
.jmw-cred-switch{display:flex;align-items:center;gap:8px;font-size:12px;cursor:pointer;
  color:var(--dsw-alias-label-primary,#1b1d22)}
.jmw-cred-switch input{width:14px;height:14px;flex:none;accent-color:var(--dsw-alias-brand-primary,#4d6bfe)}
.jmw-cred-switchlabel{line-height:1.5}
.jmw-cred-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:2px}
/* 按钮：颜色用内联 style 兜底（宿主样式表可能后加载把背景刷成白色），这里只负责尺寸与手感 */
.jmw-cred-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:30px;
  padding:6px 14px;font:inherit;font-size:12.5px;font-weight:500;line-height:1;cursor:pointer;
  appearance:none;border-radius:var(--dsw-radius-sm,8px);
  color:var(--dsw-alias-label-primary,#1b1d22);background:var(--dsw-alias-bg-layer-2,#fff);
  border:1px solid var(--dsw-alias-border-l3,rgba(38,49,72,.18))}
.jmw-cred-btn:hover:not(:disabled){filter:brightness(.97)}
.jmw-cred-btn:active:not(:disabled){filter:brightness(.92)}
.jmw-cred-btn:disabled{opacity:.5;cursor:default}
.jmw-cred-btn.primary{color:#fff;background:var(--dsw-alias-brand-primary,#4d6bfe);border-color:transparent}
.jmw-cred-btn.danger{color:#fff;background:var(--dsw-alias-state-error-primary,#d64545);border-color:transparent}
.jmw-cred-msg{font-size:12px;line-height:1.6}
.jmw-cred-msg.ok{color:var(--dsw-alias-state-success-primary,#2f9e44)}
.jmw-cred-msg.err{color:var(--dsw-alias-state-error-primary,#d64545)}
.jmw-cred-link{font-size:12px;color:var(--dsw-alias-link,#4d6bfe)}
/* 项目切换：可横向滚动的 tab 条 + 左右滚动按钮 */
/* 工作区 ↔ 项目：会话行角标、hover 卡片一行、面板里的提示条与「待关联」tab */
.jmw-ws-badge{flex:none;font-size:10.5px;line-height:16px;padding:0 6px;border-radius:999px;
  color:var(--dsw-alias-brand-primary,#4d6bfe);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4d6bfe) 12%,transparent);
  border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary,#4d6bfe) 30%,transparent)}
.jmw-ws-hover{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary,#5c6270)}
.jmw-ws-notice{display:flex;align-items:center;gap:8px;padding:4px 18px 0;font-size:12px;
  color:var(--dsw-alias-label-secondary,#5c6270)}
.jmw-ws-notice-text{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.jmw-linkbtn{flex:none;font:inherit;font-size:12px;padding:2px 8px;cursor:pointer;border-radius:var(--dsw-radius-sm,8px);
  color:var(--dsw-alias-brand-primary,#4d6bfe);background:transparent;
  border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary,#4d6bfe) 35%,transparent)}
.jmw-linkbtn:hover{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4d6bfe) 10%,transparent)}
.jmw-pill.target{outline:2px dashed color-mix(in srgb,var(--dsw-alias-brand-primary,#4d6bfe) 55%,transparent);outline-offset:1px}
.jmw-projects{display:flex;align-items:center;gap:6px;padding:0 18px 4px}
.jmw-scrollbtn{flex:none;width:24px;height:24px;display:inline-flex;align-items:center;justify-content:center;
  padding:0;font:inherit;font-size:15px;line-height:1;cursor:pointer;border-radius:var(--dsw-radius-sm,8px);
  color:var(--dsw-alias-label-secondary,#5c6270);background:transparent;
  border:1px solid var(--dsw-alias-border-l1,rgba(38,49,72,.1))}
.jmw-scrollbtn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}
.jmw-projectstrip{flex:1;min-width:0;display:flex;align-items:center;gap:6px;overflow-x:auto;padding:2px 0;
  scroll-behavior:smooth;scrollbar-width:thin}
.jmw-projectstrip::-webkit-scrollbar{height:5px}
.jmw-projectstrip::-webkit-scrollbar-thumb{background:var(--dsw-alias-scrollbar-bg-l2,rgba(0,0,0,.18));border-radius:3px}
.jmw-pill{flex:none;display:inline-flex;align-items:center;gap:6px;padding:3px 9px;font:inherit;font-size:11.5px;
  line-height:1.4;cursor:pointer;white-space:nowrap;border-radius:999px;color:var(--dsw-alias-label-secondary,#5c6270);
  background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06));border:1px solid transparent}
.jmw-pill:hover{border-color:var(--dsw-alias-border-l2,rgba(38,49,72,.18))}
.jmw-pill.on{color:#fff;background:#4d6bfe;border-color:#4d6bfe}
.jmw-cred-summary{font-size:12px;color:var(--dsw-alias-label-tertiary,#8a90a0)}
.jmw-cred-summary.err{color:#d64545}
/* 主面板标题右侧的「配置」按钮（幽灵按钮） */
.jmw-btn.ghost{background:transparent;color:var(--dsw-alias-label-secondary,#5c6270)}
.jmw-btn.ghost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}
.jmw-btn.ghost.on{color:#4d6bfe;background:color-mix(in srgb,#4d6bfe 12%,transparent)}
/* 令牌 / 配置 弹窗：宿主不给背板，整层由插件自己画（遮罩 + 居中卡片）。
   遮罩同样不加 backdrop-filter —— 理由见文件开头 .jmw-mask 上面那条注释。 */
.jmw-credmask{position:fixed;inset:0;z-index:1200;display:flex;align-items:center;justify-content:center;padding:24px;
  background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.24))}
.jmw-credmodal{display:flex;flex-direction:column;gap:2px;width:min(620px,100%);max-height:min(80vh,660px);overflow:auto;
  padding:16px 18px 18px;border-radius:var(--dsw-radius-lg,16px);background:var(--dsw-alias-bg-layer-2,#fff);
  border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));box-shadow:var(--dsw-elevation-prominent,0 18px 48px rgba(0,0,0,.24));
  font-family:var(--dsw-font-family,system-ui,-apple-system,"Segoe UI","Microsoft YaHei","PingFang SC",sans-serif);font-size:13px;line-height:1.5;
  color:var(--dsw-alias-label-primary,#1b1d22)}
.jmw-credmodal-head{display:flex;align-items:center;gap:10px;padding-bottom:10px;
  border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.06))}
.jmw-credmodal-title{flex:1;font-size:13.5px;font-weight:600}
.jmw-credmodal .jmw-cred{padding:12px 0 0}
`;

    function injectStyle() {
      if (typeof document === 'undefined') return () => {};
      if (document.querySelector(`style[data-plugin-css="${CSS_ID}"]`)) return () => {};
      const tag = document.createElement('style');
      tag.dataset.plugin = PLUGIN_ID;
      tag.dataset.pluginCss = CSS_ID;
      tag.textContent = CSS;
      document.head.appendChild(tag);
      return () => tag.remove();
    }

    /* -------------------------------------------------------------- 图标 */

    function JiraGlyph(props) {
      return h('svg', {
        viewBox: '0 0 36 36', width: props?.size ?? 28, height: props?.size ?? 28,
        className: props?.className, 'aria-hidden': true, focusable: false,
      }, [
        h('circle', { key: 'a', cx: 10, cy: 11, r: 2.6, fill: '#4D6BFE' }),
        h('path', { key: 'b', d: 'M16 11h13', stroke: '#93A5FF', strokeWidth: 2.8, strokeLinecap: 'round', fill: 'none' }),
        h('circle', { key: 'c', cx: 10, cy: 18, r: 2.1, stroke: '#93A5FF', strokeWidth: 1.8, fill: 'none' }),
        h('path', { key: 'd', d: 'M16 18h10', stroke: '#93A5FF', strokeWidth: 2.4, strokeLinecap: 'round', fill: 'none' }),
        h('circle', { key: 'e', cx: 10, cy: 25, r: 2.6, fill: '#4D6BFE' }),
        h('path', { key: 'f', d: 'M16 25h7', stroke: '#93A5FF', strokeWidth: 2.8, strokeLinecap: 'round', fill: 'none' }),
      ]);
    }

    function Chevron(props) {
      return h('svg', {
        viewBox: '0 0 16 16', width: 14, height: 14, className: `jmw-chev${props?.open ? ' open' : ''}`,
        'aria-hidden': true, focusable: false,
      }, h('path', {
        d: 'M6 3.5 10.5 8 6 12.5', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6,
        strokeLinecap: 'round', strokeLinejoin: 'round',
      }));
    }

    function RefreshGlyph() {
      return h('svg', { viewBox: '0 0 16 16', width: 15, height: 15, 'aria-hidden': true, focusable: false },
        h('path', {
          d: 'M13 8a5 5 0 1 1-1.6-3.7M13 2.5V5.5H10', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4,
          strokeLinecap: 'round', strokeLinejoin: 'round',
        }));
    }

    function SearchGlyph(props) {
      return h('svg', {
        viewBox: '0 0 16 16',
        width: 15,
        height: 15,
        className: props?.className,
        'aria-hidden': true,
        focusable: false,
      }, [
        h('circle', {
          key: 'ring', cx: 7, cy: 7, r: 4.2, fill: 'none', stroke: 'currentColor', strokeWidth: 1.4,
        }),
        h('path', {
          key: 'handle', d: 'M10.2 10.2 13.5 13.5', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4,
          strokeLinecap: 'round',
        }),
      ]);
    }

    function CloseGlyph() {
      return h('svg', { viewBox: '0 0 16 16', width: 15, height: 15, 'aria-hidden': true, focusable: false },
        h('path', {
          d: 'M4 4l8 8M12 4l-8 8', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round',
        }));
    }

    /* ------------------------------------------------------------ 组件 */

    function Entry(props) {
      const state = useSnapshot();
      const narrow = props?.wide === false;
      const unread = state.watch?.counts?.total ?? 0;
      return h('button', {
        type: 'button',
        className: `jmw-entry${narrow ? ' narrow' : ''}`,
        title: unread > 0 ? `${t('title')} · ${t('watchUnread', { count: unread })}` : t('title'),
        'aria-label': t('title'),
        onClick() {
          const open = !snapshot.open;
          // 计划失败提示是上一次点击的产物：收起 / 重开面板时一并清掉。
          patch({ open, credOpen: false, menuKey: '', filterOpen: false, autoPickedOnce: false, planError: '' });
          // 打开时若还没有数据、或上次是错误（例如当时没有会话），就顺手重试一次。
          if (open && (snapshot.error || !snapshot.data) && !snapshot.loading) load(snapshot.scope);
          // 工作区 ↔ 项目：打开面板时按当前会话的工作区把 tab 落到关联项目上（只做这一次，之后以用户选择为准）。
          if (open) {
            const p = fetchWorkspaceLinks().then(() => adoptWorkspaceProject());
            p.catch(() => undefined);
          }
        },
      }, [
        h(JiraGlyph, { key: 'glyph', size: 18 }),
        narrow ? null : h('span', { key: 'label', className: 'jmw-entry-label' }, t('title')),
        unread > 0 ? h('span', { key: 'badge', className: 'jmw-entry-badge' }, unread > 99 ? '99+' : String(unread)) : null,
      ]);
    }

    /**
     * 左栏「工作区」那一行右键菜单里的条目：把某个 Jira 项目关联到这个工作区。
     * Structured menu（ctx.contextMenus, target: 'workspace'）：不是 React 组件，
     * 所以「选哪个项目」交给面板顶部的 rail 去挑 —— 菜单条目先把候选项目写进请求，
     * 再打开面板：只有一个候选就直接落，多个就在 rail 上标出来让用户点。
     */
    function projectMenuEntry(workspace) {
      const workspaceId = String(workspace?.workspaceId ?? '');
      return {
        id: 'jira-project',
        label: t('wsLink'),
        run: () => {
          // 打开面板，并在项目 tab 条上把候选项目标成「待关联」：点哪个项目就挂到哪个工作区。
          patch({ open: true, credOpen: false, menuKey: '', filterOpen: false, autoPickedOnce: false, linkTarget: workspaceId });
          if (!snapshot.data && !snapshot.loading) load(snapshot.scope);
          void fetchWorkspaceLinks(true);
        },
      };
    }

    /** 工作区上已关联的项目：菜单里给一条「取消关联」（只放第一条，多个项目在面板 rail 里逐个取消）。 */
    function projectUnlinkEntry(workspace) {
      const workspaceId = String(workspace?.workspaceId ?? '');
      const projects = projectsOfWorkspace(workspaceId);
      if (!projects.length) return undefined;
      return {
        id: 'jira-unlink',
        label: t('wsUnlink'),
        run: () => {
          const project = projects[0];
          mutateWorkspaceLinks('unlink', { workspaceId, project })
            .then(() => { flash(t('wsUnlinkedToast', { project })); adoptWorkspaceProject(true); })
            .catch((error) => flash(t('wsFailed', { message: String(error?.message ?? error) })));
        },
      };
    }

    /** 会话行角标：这个会话所在工作区关联了哪些项目（只读，不绑定会话）。 */
    function WorkspaceBadge(props) {
      useSnapshot();
      const sessionId = String(props?.sessionId ?? '');
      const workspace = workspaceOfSessionIn(useSessionSnapshot(), sessionId);
      const projects = workspace ? projectsOfWorkspace(workspace.workspaceId) : [];
      if (!projects.length) return null;
      return h('span', {
        key: 'jira',
        className: 'jmw-ws-badge',
        title: t('wsLinked', { projects: projects.join(', ') }),
      }, projects.join(', '));
    }

    /** 会话 hover 卡片里的一行：工作区关联的 Jira 项目。 */
    function WorkspaceHoverLine(props) {
      useSnapshot();
      const sessionId = String(props?.sessionId ?? '');
      const workspace = workspaceOfSessionIn(useSessionSnapshot(), sessionId);
      const projects = workspace ? projectsOfWorkspace(workspace.workspaceId) : [];
      if (!projects.length) return null;
      return h('div', { key: 'jira', className: 'jmw-ws-hover' }, t('wsLinked', { projects: projects.join(', ') }));
    }

    function useSessionSnapshot() {
      const ctx = runtime.ctx;
      const sessions = ctx && typeof ctx.get === 'function' ? ctx.get('sessions') : undefined;
      const [value, setValue] = React.useState(() => {
        try { return sessions?.list?.getSnapshot?.() ?? null; } catch { return null; }
      });
      React.useEffect(() => {
        if (!sessions?.list?.subscribe) return undefined;
        let live = true;
        const update = () => { if (live) setValue(sessions.list.getSnapshot() ?? null); };
        const off = sessions.list.subscribe?.(update);
        update();
        return () => { live = false; if (typeof off === 'function') off(); };
      }, []);
      return value;
    }

    /** 同 workspaceOfSession，但读的是已经拿到的快照（渲染期用，避免每次渲染都 subscribe）。 */
    function workspaceOfSessionIn(sessionState, sessionId) {
      const items = sessionState?.items;
      if (!Array.isArray(items) || !sessionId) return undefined;
      return items.find((row) => Array.isArray(row?.sessionIds) && row.sessionIds.includes(sessionId));
    }

    function watchStatus(state) {
      const info = state.watch;
      if (!info) return null;
      if (info.supported === false) {
        return h('span', { key: 'watch', className: 'warn' }, t('watchUnsupported', { reason: info.reason || '—' }));
      }
      if (info.error) {
        // 后台监视失败也要说人话：host 把类型放在 lastErrorCode 里，命中表就用那句提示当原因，
        // 否则退回原始 message（协议 / 站点细节只有它说得清）。
        const meta = info.lastErrorCode ? failureMeta(info.lastErrorCode) : null;
        const message = meta ? t(meta.title) : info.error;
        return h('span', { key: 'watch', className: 'warn' }, t('watchError', { message }));
      }
      if (info.enabled === false) return h('span', { key: 'watch' }, t('watchOff'));
      const checked = info.checkedAt ? `　${t('watchChecked', { time: formatTime(info.checkedAt) })}` : '';
      return h('span', { key: 'watch' }, `${t('watch')}${checked}`);
    }

    function groupSummary(group) {
      const open = (group.counts?.new ?? 0) + (group.counts?.indeterminate ?? 0);
      const total = group.counts?.total ?? group.items.length;
      if (open === 0) return t('allDone', { total });
      return t('openOfTotal', { open, total });
    }

    function groupMetaLine(group) {
      const parts = [];
      if (group.start || group.end) {
        parts.push(h('span', { key: 'range' }, t('range', { start: group.start || '—', end: group.end || '—' })));
      }
      return parts.length === 0 ? null : h('div', { key: 'meta', className: 'jmw-meta-line' }, parts);
    }

    /** 点状态徽标后展开的流转选择条：Jira 只认这些流转，所以直接把 Host 返回的列出来。 */
    function renderStatusMenu(item) {
      const info = snapshot.statuses[item.key] ?? {};
      const chips = [];
      if (info.loading) chips.push(h('span', { key: 'loading', className: 'jmw-menu-note' }, t('statusLoading')));
      if (info.error) chips.push(h('span', { key: 'error', className: 'jmw-menu-note err' }, info.error));
      for (const row of info.list ?? []) {
        const current = row.to === info.current;
        chips.push(h('button', {
          key: row.id,
          type: 'button',
          className: `jmw-chip pick${current ? ' cur' : ''}${row.category === 'done' ? ' done' : ''}`,
          disabled: current || snapshot.busyKey === item.key,
          title: row.name === row.to ? row.to : `${row.name} → ${row.to}`,
          onClick: (event) => {
            event?.preventDefault?.();
            event?.stopPropagation?.();
            applyStatus(item.key, row);
          },
        }, `${row.to}${current ? ' ✓' : ''}`));
      }
      return h('div', { key: 'menu', className: 'jmw-menu' }, [
        h('div', { key: 'head', className: 'jmw-menu-head' }, [
          h('span', { key: 'title' }, t('pickStatus')),
          snapshot.busyKey === item.key ? h('span', { key: 'spin', className: 'jmw-spin', 'aria-hidden': true }) : null,
          h('button', {
            key: 'cancel',
            type: 'button',
            className: 'jmw-linkbtn',
            onClick: (event) => {
              event?.preventDefault?.();
              patch({ menuKey: '' });
            },
          }, t('statusCancel')),
        ]),
        h('div', { key: 'chips', className: 'jmw-menu-chips' }, chips.length ? chips : [h('span', { key: 'empty', className: 'jmw-menu-note' }, t('empty'))]),
      ]);
    }

    /**
     * tab 行右侧的「筛选」菜单：单选一个工作流状态（默认「全部状态」）。
     * 结构 / CSS 与点状态徽标展开的流转下拉（renderStatusMenu）保持一致：同一个 .jmw-menu + chips。
     * 选项来自 host 载荷的 statusOptions（模块级缓存见过到的状态 + 这次 items 里的状态，已去重、稳定排序）。
     */
    function renderFilterMenu() {
      const current = typeof snapshot.status === 'string' ? snapshot.status : '';
      const options = Array.isArray(snapshot.data?.statusOptions) ? snapshot.data.statusOptions : [];
      const chips = [
        h('button', {
          key: '__all__',
          type: 'button',
          className: `jmw-chip pick${current === '' ? ' cur' : ''}`,
          disabled: current === '',
          title: t('filterAll'),
          onClick: (event) => {
            event?.preventDefault?.();
            selectStatusFilter('');
          },
        }, `${t('filterAll')}${current === '' ? ' ✓' : ''}`),
        ...options.map((row) => {
          const name = String(row?.name ?? '');
          if (!name) return null;
          const on = name === current;
          return h('button', {
            key: name,
            type: 'button',
            className: `jmw-chip pick${on ? ' cur' : ''}${row?.category === 'done' ? ' done' : ''}`,
            disabled: on,
            title: name,
            onClick: (event) => {
              event?.preventDefault?.();
              selectStatusFilter(name);
            },
          }, `${name}${on ? ' ✓' : ''}`);
        }).filter(Boolean),
      ];
      return h('div', { key: 'filter', className: 'jmw-menu' }, [
        h('div', { key: 'head', className: 'jmw-menu-head' }, [
          h('span', { key: 'title' }, t('filterTitle')),
          h('button', {
            key: 'cancel',
            type: 'button',
            className: 'jmw-linkbtn',
            onClick: (event) => {
              event?.preventDefault?.();
              patch({ filterOpen: false });
            },
          }, t('statusCancel')),
        ]),
        h('div', { key: 'chips', className: 'jmw-menu-chips' }, chips.length ? chips : [h('span', { key: 'empty', className: 'jmw-menu-note' }, t('empty'))]),
      ]);
    }

    /** 选中一个状态（'' = 全部状态）→ 关菜单 → 用新筛选重查一次；渐进式渲染进度归零。 */
    function selectStatusFilter(name) {
      const next = typeof name === 'string' ? name : '';
      patch({ status: next, filterOpen: false });
      load(snapshot.scope);
    }

    /**
     * 优先级分级。名次由 host 给（priorityRank = GET /rest/api/3/priority 的数组下标，0 = Jira 里的最高级），
     * 所以站点调了顺序、或用 P0 / Blocker 这类自定义名字，界面都跟着走，不再把 "Highest" 写死成最高级。
     * 仍只给最高的两级上底色（0 红、1 琥珀），再低的不上色——只靠徽标显示名字就够了。
     * 名次拿不到（旧载荷 / 站点没给这个接口 / 离线）才退回按名字判断。
     */
    function priorityLevel(item) {
      const rank = Number.isInteger(item?.priorityRank) ? item.priorityRank : null;
      if (rank !== null) return rank === 0 ? 'highest' : (rank === 1 ? 'high' : '');
      const name = String(item?.priority ?? '').trim().toLowerCase();
      if (name === 'highest' || name === 'highest priority' || name === '最高' || name === '最高级') return 'highest';
      if (name === 'high' || name === '高') return 'high';
      return '';
    }

    function renderRow(item) {
      const title = `${item.summary || t('untitled')}${item.parent ? ` · ${t('parent', { key: item.parent })}` : ''}`;
      const open = snapshot.menuKey === item.key;
      const level = priorityLevel(item);
      const meta = [];
      if (item.status) {
        // 状态徽标本身就是下拉入口（行本身是链接，所以这里 stopPropagation 防止误跳转）。
        meta.push(h('button', {
          key: 'status',
          type: 'button',
          className: `jmw-badge act${open ? ' on' : ''}`,
          title: t('setStatus'),
          'aria-haspopup': 'true',
          'aria-expanded': open ? 'true' : 'false',
          onClick: (event) => {
            event?.preventDefault?.();
            event?.stopPropagation?.();
            toggleStatusMenu(item.key);
          },
        }, [
          h('span', { key: 'text' }, item.status),
          h('span', { key: 'caret', className: 'jmw-caret', 'aria-hidden': true }, '▾'),
        ]));
      }
      if (level) {
        meta.push(h('span', { key: 'pri', className: `jmw-badge pri ${level}` }, item.priority));
      }
      if (item.due) {
        meta.push(h('span', {
          key: 'due',
          className: `jmw-badge${item.overdue ? ' overdue' : ' quiet'}`,
        }, item.overdue ? t('overdue', { date: item.due }) : t('due', { date: item.due })));
      } else if (item.updated) {
        meta.push(h('span', { key: 'updated', className: 'jmw-badge quiet' }, t('updated', { date: item.updated })));
      }
      // 「计划」：在项目绑定的工作区里开一条 plan 模式会话（一个任务只有一条，重复点击只打开）。
      const planning = snapshot.planBusy === item.key;
      const hasPlan = Boolean(plans.sessions[item.key]);
      meta.push(h('button', {
        key: 'plan',
        type: 'button',
        className: `jmw-badge act plan${hasPlan ? ' on' : ''}`,
        title: hasPlan ? t('planOpened', { key: item.key }) : t('planButton'),
        disabled: planning || Boolean(snapshot.planBusy),
        onClick: (event) => {
          event?.preventDefault?.();
          event?.stopPropagation?.();
          void startPlan(item);
        },
      }, [
        h('span', { key: 'icon', className: 'jmw-planicon', 'aria-hidden': true }, '☰'),
        h('span', { key: 'text' }, planning ? t('planBusy') : t('planButton')),
      ]));
      // 已绑定才有「删」：归档那条会话并解绑，任务回到「没计划过」。
      if (hasPlan) {
        meta.push(h('button', {
          key: 'plan-drop',
          type: 'button',
          className: 'jmw-badge act plan-drop',
          title: t('planDrop'),
          'aria-label': t('planDrop'),
          disabled: planning || Boolean(snapshot.planBusy),
          onClick: (event) => {
            event?.preventDefault?.();
            event?.stopPropagation?.();
            void dropPlan(item);
          },
        }, '×'));
      }
      const classes = ['jmw-row'];
      if (item.category === 'done') classes.push('done');
      if (open) classes.push('open');
      if (level) classes.push(`pri-${level}`);
      // 从属关系（非线性关联）：epic / 父任务各一行，点一下就地跳到那条任务（在当前列表里时）。
      // 两者都没有就完全不占高度——关联是「有才显示」的一等信息，不是每行固定多一行。
      const relation = renderRelation(item);
      return h('div', {
        key: item.key,
        className: classes.join(' '),
        // 关联行「跳到那条任务」靠它定位（虚拟列表里只挂视口内的行，所以可能滚不到，见 renderRelation）。
        'data-item-key': item.key,
      }, [
        h('a', {
          key: 'main',
          className: 'jmw-main',
          href: item.url,
          target: '_blank',
          rel: 'noreferrer',
          title,
        }, [
          h('span', { key: 'dot', className: `jmw-dot ${item.category}` }),
          h('span', { key: 'key', className: 'jmw-key' }, item.key),
          h('span', { key: 'sum', className: 'jmw-sum' }, item.summary || t('untitled')),
        ]),
        h('span', { key: 'meta', className: 'jmw-rowmeta' }, meta),
        relation,
        open ? renderStatusMenu(item) : null,
      ]);
    }

    /**
     * 一行的从属关系。epic 优先（它才是「跨项目」的那条线），没有 epic 再退回父任务。
     * 点一下：目标任务就在当前列表里 → 切到「全部项目」并把该行滚到视口中间；不在列表里（比如
     * 父任务指派给别人）→ 新窗口打开 Jira 的该条 issue。两者都不改变列表数据，只动视图。
     */
    function renderRelation(item) {
      const epicKey = String(item.epicKey ?? '').trim();
      const parentKey = String(item.parentKey ?? item.parent ?? '').trim();
      const key = epicKey || parentKey;
      if (!key) return null;
      const isEpic = Boolean(epicKey);
      const summary = isEpic ? String(item.epicSummary ?? '').trim() : String(item.parentSummary ?? '').trim();
      const label = isEpic ? t('relEpic', { key }) : t('relParent', { key });
      const baseUrl = String(snapshot.data?.items?.find((row) => row?.url)?.url ?? '').replace(/\/browse\/[^/]*$/, '');
      const url = `${baseUrl}/browse/${encodeURIComponent(key)}`;
      const focus = () => {
        const present = (snapshot.data?.items ?? []).some((row) => row?.key === key);
        if (!present) {
          if (typeof window !== 'undefined' && typeof window.open === 'function') window.open(url, '_blank', 'noopener');
          return;
        }
        // 先落到「全部项目」再滚：该任务可能属于另一个项目的 tab，只滚不切会滚到不存在的位置。
        patch({ project: 'ALL' });
        requestAnimationFrame(() => {
          const host = typeof document !== 'undefined' ? document.querySelector('.jmw-body') : null;
          const target = host?.querySelector?.(`[data-item-key="${cssEscape(key)}"]`);
          if (target && typeof target.scrollIntoView === 'function') target.scrollIntoView({ block: 'center', behavior: 'smooth' });
        });
      };
      return h('button', {
        key: 'relation',
        type: 'button',
        className: `jmw-rel${isEpic ? ' epic' : ''}`,
        title: summary ? `${label} · ${summary}` : t('relOpen', { key }),
        onClick: (event) => {
          event?.preventDefault?.();
          event?.stopPropagation?.();
          focus();
        },
      }, [
        h('span', { key: 'arrow', className: 'jmw-relarrow', 'aria-hidden': true }, '↳'),
        h('span', { key: 'label', className: 'jmw-rellabel' }, label),
        summary ? h('span', { key: 'summary', className: 'jmw-relsummary' }, summary) : null,
      ]);
    }

    /** 选择器里的任务键（PROJ-123）只含字母数字与连字符，转义只为稳妥，不引入依赖。 */
    function cssEscape(value) {
      return String(value).replace(/["\\\]]/g, (ch) => `\\${ch}`);
    }

    function Panel() {
      const state = useSnapshot();
      const cardRef = React.useRef(null);
      const credRef = React.useRef(null);
      const stripRef = React.useRef(null);
      const searchRef = React.useRef(null);
      const searchWrapRef = React.useRef(null);
      // 真正的滚动容器（.jmw-body）：虚拟列表必须挂在它上面。
      const bodyRef = React.useRef(null);
      // 令牌用独立弹窗展示（标题右侧的「配置」按钮开关）。
      // 这个开关放在共享 snapshot 里而不是组件 state：关面板时能一次性把所有浮层
      // （令牌弹窗、状态下拉）都收掉，下次打开不会「任务列表 + 配置」两个一起冒出来。
      const credOpen = state.credOpen === true;
      const setCredOpen = (value) => patch({ credOpen: typeof value === 'function' ? value(credOpen) : value });
      // 关面板 = 连所有浮层一起关：否则下次点开入口会「列表 + 配置」两个弹窗叠着出现。
      // 搜索框不算浮层（它在标题栏里，和项目 tab / 状态筛选一样跨开关保留），所以不在这里收。
      const closeAll = () => patch({ open: false, credOpen: false, menuKey: '', filterOpen: false });
      // 正在等工作区挑项目（左栏工作区右键 →「关联 Jira 项目…」）：非空时项目 tab 变成「点一下就挂上去」。
      const linkTarget = typeof state.linkTarget === 'string' ? state.linkTarget : '';

      // 搜索：放大镜就在标题栏原位，点开后在同一个位置向左展开输入框、失焦收回按钮。
      // 草稿（searchDraft）与已生效的搜索词（searchText）分开：回车才切词并清空输入框；
      // 只打字不回车时草稿留着，收起再展开能接着改。结果与「我的工作」共用同一套
      // sprint 分组 / 项目 tab / 状态筛选。
      const searchOpen = state.searchOpen === true;
      const searchText = typeof state.searchText === 'string' ? state.searchText : '';
      const searchDraft = typeof state.searchDraft === 'string' ? state.searchDraft : '';
      const openSearch = () => patch({
        searchOpen: true,
        // 不覆盖草稿：上次没回车的内容要原样留着；已生效的词在副标题里能看到。
        filterOpen: false,
        menuKey: '',
      });
      const submitSearch = () => {
        const next = searchDraft.trim();
        // 搜索是整站范围：先把项目 tab 归到「全部」，否则旧 tab 可能把所有结果都过滤掉。
        // 已执行搜索 → 清空输入框（结果靠副标题里的「搜索：…」提示），避免和生效词混淆。
        patch({ searchText: next, searchDraft: '', project: next ? 'ALL' : snapshot.project, menuKey: '', filterOpen: false });
        // patch 直接改共享 snapshot，load 里现读 searchText，所以这里不用等重渲染。
        load(snapshot.scope);
      };
      // 失焦收起：relatedTarget 还在框内（比如点清除按钮）就不收。
      const onSearchBlur = (event) => {
        const next = event?.relatedTarget;
        if (next && searchWrapRef.current?.contains?.(next)) return;
        patch({ searchOpen: false });
      };
      const clearSearch = () => {
        patch({ searchText: '', searchDraft: '', searchOpen: false });
        load(snapshot.scope);
      };

      // 展开时把焦点放进输入框；草稿会保留，所以直接全选便于改写。
      React.useEffect(() => {
        if (!searchOpen) return;
        const input = searchRef.current;
        input?.focus?.();
        input?.select?.();
      }, [searchOpen]);

      React.useEffect(() => {
        if (!state.open || typeof document === 'undefined') return undefined;
        const onKeyDown = (event) => {
          if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing
            || event.keyCode === 229 || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || event.repeat) return;
          event.preventDefault?.();
          // Esc 的顺序：令牌弹窗 → 状态下拉 → 筛选菜单 → 搜索框 → 面板。
          // 搜索框收起时草稿与已生效的搜索词都留着（结果还在列表里），再点放大镜接着用。
          if (credOpen) {
            setCredOpen(false);
            return;
          }
          if (snapshot.menuKey) {
            patch({ menuKey: '' });
            return;
          }
          if (snapshot.filterOpen) {
            patch({ filterOpen: false });
            return;
          }
          if (snapshot.searchOpen) {
            patch({ searchOpen: false });
            return;
          }
          closeAll();
        };
        document.addEventListener('keydown', onKeyDown, true);
        return () => document.removeEventListener('keydown', onKeyDown, true);
      }, [state.open, state.credOpen, state.menuKey, state.filterOpen, state.searchOpen]);

      // 下面这些纯计算放在早退之前：Panel 的 hook 调用顺序每次都要一样
      //（虚拟列表的 useVirtualizer 与滚动重置 effect 都在这一层调用）。
      const scope = state.scope;
      const tabs = projectTabs(state.data);
      // 选中的项目在新结果里没了（例如那批 issue 做完了）就自动回到「全部」。
      const project = tabs.some((tab) => tab.key === state.project) ? state.project : 'ALL';
      // 分组维度：sprint（默认）| epic（按 epic 从属关系）。两者共用折叠 / 虚拟列表 / 计数。
      const groupMode = state.groupMode === 'epic' ? 'epic' : 'sprint';
      const groups = buildGroups(state.data, project, groupMode);
      // 当前实际加载到的行数（用于「已加载 N 条 / 加载更多」）。
      const loadedCount = projectItems(state.data, project).length;
      // 「共 N 项」= approximate-count 拿到的准确总数（不是当前页条数）；拿不到就不显示
      // （用户 2026-11-18 的口径：宁可空着，也不给一个会变的数）。选中项目 tab 时给该项目的总数。
      const totalValue = project === 'ALL' ? state.data?.total : state.data?.projectTotals?.[project];
      const allCollapsed = groups.length > 0 && groups.every((group) => groupCollapsed(scope, group));
      const statusFilter = typeof state.status === 'string' ? state.status : '';

      // 虚拟列表（用户 2026-11-18：「不设上限，但要用虚拟列表保证渲染效率」）：数据一次全拿到，
      // 把「可见行」拍平成一维 entries 交给 @tanstack/react-virtual —— 组头、每条 issue、空态都是**同一个
      // 序列里的一个条目**，DOM 里只有视口内的那些行（+ overscan）。折叠的组只产出组头，不产出它的行。
      const entries = [];
      for (const group of groups) {
        const collapsed = groupCollapsed(scope, group);
        entries.push({ kind: 'group', key: `g:${group.key}`, group, collapsed });
        if (collapsed) continue;
        for (const item of group.items) entries.push({ kind: 'item', key: `i:${item.key}`, item });
      }
      if (entries.length === 0) entries.push({ kind: 'empty', key: 'empty' });

      if (typeof useVirtualizer !== 'function' && !virtualWarned) {
        virtualWarned = true;
        // 基座模块表里应该有它；真没有就退回「直接渲染全部行」，只是不能崩。
        try { console.warn('[jira-work-overview] @tanstack/react-virtual 不可用，退回直接渲染全部行'); } catch { /* ignore */ }
      }
      const useVirtual = typeof useVirtualizer === 'function' ? useVirtualizer : fallbackVirtualizer;
      const rowVirtualizer = useVirtual({
        count: entries.length,
        getScrollElement: () => bodyRef.current,
        // 关键：量出来的高度必须跟着**条目身份**走，不能跟着下标走（库的默认 getItemKey 是 `index => index`，
        // 见 defaultKeyExtractor）。折叠 / 展开会让同一串下标换成完全不同的条目：折叠前 index 1 是任务行
        // （约 32px），折叠后 index 1 变成第二个组头（约 64px）—— 按下标复用旧高度，组头就会被压在一起，
        // 「日期和标题」错位（用户 2026-11-19 报的「折叠全部后样式错误」）。元素缓存 elementsCache 同理。
        getItemKey: (index) => entries[index]?.key ?? index,
        // 组头 / 任务行分开估，把「量到真实高度之前」的位移压到最小；量过的行以真实高度为准。
        estimateSize: (index) => (entries[index]?.kind === 'group' ? GROUP_ESTIMATE : ROW_ESTIMATE),
        overscan: ROW_OVERSCAN,
        // 行高真的会变（状态下拉展开、摘要换行）：把行元素交回去重新量。
        measureElement: (element) => (element && typeof element.getBoundingClientRect === 'function'
          ? element.getBoundingClientRect().height
          : ROW_ESTIMATE),
      });
      const virtualRows = rowVirtualizer.getVirtualItems();
      const virtualSize = rowVirtualizer.getTotalSize();

      // 换项目 tab / 换状态筛选 / 换搜索词 / 刷新出新数据：滚动位置回到顶部（比较自然）。
      // 折叠只是重算条目，不动滚动位置，所以不放进 deps。
      const scrollResetKey = `${groupMode}|${project}|${statusFilter}|${searchText}|${state.data?.generatedAt ?? ''}`;
      React.useEffect(() => {
        const element = bodyRef.current;
        if (!element) return; // 迷你 React / 还没挂载：没有可滚动元素
        element.scrollTop = 0;
        rowVirtualizer.scrollToIndex?.(0);
      }, [scrollResetKey]);

      if (!state.open) return null;

      // 标题下的副标题 = 当前搜索词（如果有）+ 筛选后的准确总数（拿不到就不显示数字）+ 当前状态筛选。
      // zh 的 filterStatusPrefix 自带前导「· 」，总数拿不到时把开头的「· 」抹掉，不留一个怪符号。
      const subtitle = [
        searchText ? t('searchResultPrefix', { query: searchText }) : '',
        typeof totalValue === 'number' && Number.isFinite(totalValue) ? t('scopeTotal', { count: totalValue }) : '',
        statusFilter ? t('filterStatusPrefix', { name: statusFilter }) : '',
      ].filter(Boolean).join(' ').replace(/^·\s*/, '');

      const onKeyDown = (event) => {
        if (event.key !== 'Tab') return;
        const root = (credOpen ? credRef.current : null) ?? cardRef.current;
        if (!root || typeof root.querySelectorAll !== 'function') return;
        const nodes = [...root.querySelectorAll('button:not(:disabled), a[href], [tabindex="0"]')];
        if (nodes.length === 0) return;
        const first = nodes[0];
        const last = nodes[nodes.length - 1];
        const active = typeof document !== 'undefined' ? document.activeElement : undefined;
        if (event.shiftKey && active === first) {
          event.preventDefault();
          last.focus?.();
        } else if (!event.shiftKey && active === last) {
          event.preventDefault();
          first.focus?.();
        }
      };

      const unread = state.watch?.counts?.total ?? 0;
      const changes = Array.isArray(state.watch?.changes) ? state.watch.changes : [];
      const banner = unread > 0
        ? h('div', { key: 'watch', className: 'jmw-watch' }, [
          h('div', { key: 'text', className: 'jmw-watch-text' }, [
            h('strong', { key: 'title' }, t('watchUnread', { count: unread })),
            ...changes.slice(0, 3).map((change, index) => h('span', { key: `c${index}` }, describeChange(change))),
          ]),
          h('button', {
            key: 'ack',
            type: 'button',
            className: 'jmw-btn',
            onClick: () => markWatchRead(),
          }, t('markRead')),
        ])
        : null;

      let body;
      if (state.failure) {
        // 可分类的失败：标题 + 一句「怎么办」+ 按钮；原始报错只在 detail 类里以小字附在下面。
        const meta = failureMeta(state.failure.code);
        const actions = [];
        if (meta.config) {
          actions.push(h('button', {
            key: 'config',
            type: 'button',
            className: 'jmw-btn primary',
            onClick: () => setCredOpen(true),
          }, t('failOpenConfig')));
        }
        actions.push(h('button', {
          key: 'retry',
          type: 'button',
          className: 'jmw-btn',
          onClick: () => load(snapshot.scope),
        }, t('retry')));
        body = h('div', { className: 'jmw-state err jmw-failure' }, [
          h('div', { key: 'title', className: 'jmw-failure-title' }, t(meta.title)),
          h('div', { key: 'hint', className: 'jmw-failure-hint' }, t(meta.hint)),
          h('div', { key: 'actions', className: 'jmw-failure-actions' }, actions),
          meta.detail && state.failure.message
            ? h('div', { key: 'detail', className: 'jmw-failure-detail' }, t('failDetail', { message: state.failure.message }))
            : null,
        ]);
      } else if (state.error) {
        body = h('div', { className: 'jmw-state err' }, [
          h('div', { key: 'msg', className: 'msg' }, state.error),
          h('button', { key: 'retry', type: 'button', className: 'jmw-btn', onClick: () => load(snapshot.scope) }, t('retry')),
        ]);
      } else if (state.loading && !state.data) {
        body = h('div', { className: 'jmw-state' }, [1, 2, 3, 4, 5].map((row) => h('div', { key: row, className: 'jmw-skel' })));
      } else {
        // 虚拟列表：占位容器撑到 getTotalSize()，只有 getVirtualItems() 给的窗口内的条目真的在 DOM 里，
        // 每条用 translateY(start) 定位。data-index + ref 交给 measureElement 量真实行高（行高会变）。
        body = h('div', {
          key: 'vlist',
          className: 'jmw-vlist',
          style: { height: `${virtualSize}px` },
        }, virtualRows.map((row) => {
          const entry = entries[row.index];
          if (!entry) return null;
          return h('div', {
            key: entry.key,
            className: 'jmw-vrow',
            'data-index': row.index,
            ref: typeof rowVirtualizer.measureElement === 'function' ? rowVirtualizer.measureElement : undefined,
            style: { transform: `translateY(${row.start}px)` },
          }, renderEntry(entry));
        }));
      }

      /** 一维 entries 里的一个条目 → 一个 DOM 行（组头 / 任务行 / 空态）。 */
      function renderEntry(entry) {
        if (entry.kind === 'group') {
          return h('section', { className: 'jmw-group' }, [
            h('button', {
              key: 'head',
              type: 'button',
              className: 'jmw-grouphead',
              'aria-expanded': entry.collapsed ? 'false' : 'true',
              onClick: () => setGroupCollapsed(scope, entry.group, !entry.collapsed),
            }, [
              h(Chevron, { key: 'chev', open: !entry.collapsed }),
              h('span', { key: 'name', className: 'jmw-sprint' }, entry.group.name),
              // epic 视图专有：这组横跨几个项目（跨项目才是「非线性关联」最值得看的一眼）。
              entry.group.projects?.length > 1
                ? h('span', { key: 'projects', className: 'jmw-epicprojects' }, t('epicProjects', { count: entry.group.projects.length }))
                : null,
              h('span', { key: 'count', className: 'jmw-count' }, groupSummary(entry.group)),
            ]),
            groupMetaLine(entry.group),
          ]);
        }
        if (entry.kind === 'item') return renderRow(entry.item);
        return h('div', { className: 'jmw-state' }, state.loading ? t('loading') : (searchText ? t('searchEmpty') : t('empty')));
      }

      // 「加载更多」：只在 host 真的截断时出现（面板固定要 --limit=0，所以这只可能是撞到了
      // host 的安全上限 5000 条 / 50 页 / 30s）。此时上限已经顶到底，抬不上去，按钮禁用。
      const cappedCount = Number(state.data?.limit) > 0 ? Number(state.data.limit) : LIMIT_MAX;
      const moreBlock = loadedCount > 0 && state.data?.hasMore
        ? h('div', { key: 'more', className: 'jmw-more' }, [
          h('button', {
            key: 'btn',
            type: 'button',
            className: 'jmw-btn',
            disabled: true,
            title: t('loadMoreHint'),
            onClick: () => {},
          }, t('loadMoreCap', { cap: cappedCount })),
          h('span', { key: 'now', className: 'jmw-morehint' }, t('loadedOf', { count: loadedCount, limit: cappedCount })),
        ])
        : null;

      const card = h('div', {
        className: 'jmw-card',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': t('title'),
        ref: cardRef,
        onKeyDown,
      }, [
        h('div', { key: 'head', className: 'jmw-head' }, [
          h(JiraGlyph, { key: 'glyph', className: 'jmw-glyph', size: 28 }),
          h('div', { key: 'text', className: 'jmw-headtext' }, [
            h('div', { key: 'title', className: 'jmw-title' }, t('title')),
            subtitle ? h('div', { key: 'sub', className: 'jmw-sub' }, subtitle) : null,
          ]),
          // 搜索：按钮与展开后的输入框是同一个容器（同一位置），靠宽度过渡向左长出来。
          h('div', {
            key: 'search',
            className: `jmw-searchexpand${searchOpen ? ' open' : ''}`,
            ref: searchWrapRef,
            onBlur: onSearchBlur,
          }, [
            h('div', { key: 'box', className: 'jmw-searchbox' }, [
              h(SearchGlyph, { key: 'icon', className: 'jmw-searchicon' }),
              // 输入框常驻：收起动画期间字还在框里，看起来是「收缩回去」而不是「整块消失」；
              // 收起时用 tabIndex / readOnly 关掉交互，宽度、透明度和指针都由外层 .open 控制。
              h('input', {
                key: 'input',
                ref: searchRef,
                type: 'search',
                className: 'jmw-searchinput',
                value: searchDraft,
                placeholder: t('searchPlaceholder'),
                title: t('searchHint'),
                'aria-label': t('searchOpen'),
                tabIndex: searchOpen ? 0 : -1,
                readOnly: !searchOpen,
                onChange: (event) => {
                  if (!searchOpen) return;
                  patch({ searchDraft: event?.target?.value ?? '' });
                },
                onKeyDown: (event) => {
                  if (searchOpen && event?.key === 'Enter' && !event.isComposing) {
                    event.preventDefault?.();
                    submitSearch();
                  }
                },
              }),
              searchOpen && (searchText || searchDraft)
                ? h('button', {
                  key: 'clear',
                  type: 'button',
                  className: 'jmw-searchclear',
                  title: t('searchClear'),
                  'aria-label': t('searchClear'),
                  onClick: clearSearch,
                }, '×')
                : null,
            ]),
            h('button', {
              key: 'btn',
              type: 'button',
              className: `jmw-iconbtn jmw-searchbtn${searchOpen ? ' on' : ''}${searchText ? ' set' : ''}`,
              title: searchText ? t('searchResultPrefix', { query: searchText }) : t('searchOpen'),
              'aria-label': t('searchOpen'),
              'aria-expanded': searchOpen ? 'true' : 'false',
              tabIndex: searchOpen ? -1 : 0,
              onClick: () => (searchOpen ? patch({ searchOpen: false }) : openSearch()),
            }, h(SearchGlyph)),
          ]),
          h('button', {
            key: 'cred',
            type: 'button',
            className: `jmw-btn ghost${credOpen ? ' on' : ''}`,
            title: t('credTitle'),
            'aria-label': t('credTitle'),
            'aria-expanded': credOpen ? 'true' : 'false',
            onClick: () => setCredOpen((value) => !value),
          }, t('credOpen')),
          state.loading ? h('span', { key: 'spin', className: 'jmw-spin', 'aria-hidden': true }) : null,
          h('button', {
            key: 'refresh',
            type: 'button',
            className: 'jmw-iconbtn',
            title: t('refresh'),
            'aria-label': t('refresh'),
            disabled: state.loading,
            onClick: () => load(snapshot.scope),
          }, h(RefreshGlyph)),
          h('button', {
            key: 'close',
            type: 'button',
            className: 'jmw-iconbtn',
            title: t('close'),
            'aria-label': t('close'),
            onClick: () => closeAll(),
          }, h(CloseGlyph)),
        ]),
        // 关联提示：正在挑项目 / 本工作区已关联某个项目（面板刚按它跳过来）时各给一行说明。
        renderWorkspaceNotice(),
        // tab 行：项目 tab（左滚 / 条 / 右滚）+ 状态筛选 + 展开全部 / 折叠全部。
        // 范围分段控件（未完成 / 全部）与它右侧的总数已删（用户 2026-11-18）：范围固定为 all，
        // 总数移到标题下的副标题，「展开 / 折叠全部」从原来的第二行挪到这里。
        state.data
          ? h('div', { key: 'projects', className: 'jmw-projects' }, [
            tabs.length > 1
              ? h('button', {
                key: 'left',
                type: 'button',
                className: 'jmw-scrollbtn',
                title: t('scrollLeft'),
                'aria-label': t('scrollLeft'),
                onClick: () => stripRef.current?.scrollBy?.({ left: -180, behavior: 'smooth' }),
              }, '‹')
              : null,
            h('div', { key: 'strip', className: 'jmw-projectstrip', ref: stripRef }, tabs.map((tab) => h('button', {
              key: tab.key,
              type: 'button',
              className: `jmw-pill${tab.key === project ? ' on' : ''}${linkTarget && tab.key !== 'ALL' ? ' target' : ''}`,
              'aria-pressed': tab.key === project ? 'true' : 'false',
              title: linkTarget && tab.key !== 'ALL' ? t('wsLinked', { projects: tab.key }) : undefined,
              // 切项目 tab：数据已经全在手里，不需要重新查询，也没有「分批画」的状态要重置；
              // 滚动位置由 Panel 里的一个 effect 统一拉回顶部（换 tab / 换筛选都会）。
              // 正在等挑项目时，点项目 tab = 把该项目挂到那个工作区（选中态也一起切过去）。
              onClick: linkTarget && tab.key !== 'ALL' ? () => linkWorkspaceProject(linkTarget, tab.key) : () => patch({ project: tab.key }),
            }, h('span', { key: 'name', className: 'jmw-pillname' }, tab.key === 'ALL' ? t('projectAll') : tab.key)))),
            tabs.length > 1
              ? h('button', {
                key: 'right',
                type: 'button',
                className: 'jmw-scrollbtn',
                title: t('scrollRight'),
                'aria-label': t('scrollRight'),
                onClick: () => stripRef.current?.scrollBy?.({ left: 180, behavior: 'smooth' }),
              }, '›')
              : null,
            // 分组维度：按迭代（默认）/ 按 epic。放在筛选左边，选中态与筛选按钮同一套样式。
            h('span', { key: 'groupmode', className: 'jmw-groupmode', role: 'group', 'aria-label': t('groupByEpic') }, [
              h('button', {
                key: 'sprint',
                type: 'button',
                className: `jmw-filterbtn${groupMode === 'sprint' ? ' set' : ''}`,
                'aria-pressed': groupMode === 'sprint' ? 'true' : 'false',
                onClick: () => patch({ groupMode: 'sprint' }),
              }, t('groupBySprint')),
              h('button', {
                key: 'epic',
                type: 'button',
                className: `jmw-filterbtn${groupMode === 'epic' ? ' set' : ''}`,
                'aria-pressed': groupMode === 'epic' ? 'true' : 'false',
                onClick: () => patch({ groupMode: 'epic' }),
              }, t('groupByEpic')),
            ]),
            // 单选状态筛选：平时显示「筛选」，选了某个状态后显示状态名（保持一致）。
            h('button', {
              key: 'filter',
              type: 'button',
              className: `jmw-filterbtn${state.filterOpen ? ' on' : ''}${statusFilter ? ' set' : ''}`,
              title: statusFilter ? t('filterStatusPrefix', { name: statusFilter }).replace(/^·\s*/, '') : t('filterTitle'),
              'aria-label': t('filterTitle'),
              'aria-expanded': state.filterOpen ? 'true' : 'false',
              onClick: () => patch({ filterOpen: !state.filterOpen, menuKey: '' }),
            }, `${statusFilter || t('filterTitle')} ▾`),
            groups.length > 0
              ? h('button', {
                key: 'all',
                type: 'button',
                className: 'jmw-linkbtn',
                onClick: () => setAllCollapsed(scope, groups, !allCollapsed),
              }, allCollapsed ? t('expandAll') : t('collapseAll'))
              : null,
          ])
          : null,
        // 筛选菜单：结构 / CSS 与状态下拉一致，渲染在 tab 行下面一行。
        state.filterOpen ? renderFilterMenu() : null,
        banner,
        state.flash ? h('div', { key: 'flash', className: 'jmw-flash' }, state.flash) : null,
        // 「计划」失败的提示：带一个 × 手动关掉（正文里会说明是没绑工作区还是建会话失败）。
        state.planError
          ? h('div', { key: 'plan-error', className: 'jmw-flash err', role: 'alert' }, [
            h('span', { key: 'text' }, state.planError),
            h('button', {
              key: 'close',
              type: 'button',
              className: 'jmw-flashclose',
              title: t('close'),
              'aria-label': t('close'),
              onClick: () => patch({ planError: '' }),
            }, '×'),
          ])
          : null,
        // 切范围时旧列表留在原位（原子替换，不闪空），同时压暗一档表示「这批是上一个 tab 的」。
        // 这里就是**真正的滚动容器**：虚拟列表挂在它上面，列表、组头、空态、「加载更多」都在它里面滚。
        h('div', {
          key: 'body',
          className: `jmw-body${state.loading && state.data ? ' pending' : ''}`,
          'aria-busy': state.loading ? 'true' : 'false',
          ref: bodyRef,
        }, [body, moreBlock]),
        h('div', { key: 'foot', className: 'jmw-foot' }, [
          state.data?.generatedAt ? h('span', { key: 'time' }, t('generated', { time: formatTime(state.data.generatedAt) })) : null,
          state.data?.credentialSource ? h('span', { key: 'cred' }, t('credentials', { source: state.data.credentialSource })) : null,
          // 范围固定为 all（含已完成 / 已关闭），不再显示范围文案；只看当前单选的状态筛选。
          statusFilter ? h('span', { key: 'status' }, t('filterStatusPrefix', { name: statusFilter }).replace(/^·\s*/, '')) : null,
          // 条数口径：`limit: 0` = 不限制 —— 「已加载 N 条（全部）」；万一是正数上限就照旧写上限；
          // 到了 5000 条安全上限还 hasMore 就明说「已达安全上限，还有更多」，不假装取完了。
          state.data?.limit
            ? h('span', { key: 'limit' }, t('loadedOf', { count: loadedCount, limit: state.data.limit }))
            : state.data
              ? h('span', { key: 'limit' }, state.data.hasMore
                ? t('loadedCapped', { count: loadedCount, cap: LIMIT_MAX })
                : t('loadedAll', { count: loadedCount }))
              : null,
          watchStatus(state),
        ]),
      ]);

      const credModal = credOpen
        ? h('div', {
          key: 'credmodal',
          className: 'jmw-credmask',
          onClick: (event) => {
            if (event.target === event.currentTarget) setCredOpen(false);
          },
        }, h('div', {
          className: 'jmw-credmodal',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': t('credTitle'),
          ref: credRef,
          onKeyDown,
        }, [
          h('div', { key: 'head', className: 'jmw-credmodal-head' }, [
            h('div', { key: 'title', className: 'jmw-credmodal-title' }, t('credTitle')),
            h('button', {
              key: 'close',
              type: 'button',
              className: 'jmw-iconbtn',
              title: t('close'),
              'aria-label': t('close'),
              onClick: () => setCredOpen(false),
            }, h(CloseGlyph)),
          ]),
          h(CredentialSettings, { key: 'body', view: 'page' }),
        ]))
        : null;

      const mask = h('div', {
        className: 'jmw-mask',
        onClick: (event) => {
          if (event.target === event.currentTarget) closeAll();
        },
      }, credOpen ? [card, credModal] : card);
      if (typeof createPortal === 'function' && typeof document !== 'undefined') {
        return createPortal(mask, document.body);
      }
      return h('div', { className: 'jmw-inline', style: { position: 'fixed', inset: 0, zIndex: 1000 } }, mask);
    }

    /* ------------------------------------------------- 插件配置页：Jira 令牌 */

    /*
     * 插件列表里「Jira work overview」这一行的配置页（slots: plugins.row.config）。
     * 换令牌这件事不走 Host 设置文档，而是走 Host 自己开的一条精确 Fetch 路由：
     * 值只写进 DSH 凭据库的同一个键（默认 JIRA_API_TOKEN），读取时已经打码，界面拿不到完整令牌。
     */
    // ---- 配置页的小零件（标题 + 内容 两段式，按功能分组） ----
    // 跟随主题的颜色一律写死成「深底 + 白字」或「主题底色 + 主题字色」：
    // 不能用 --dsw-alias-brand-primary 当按钮底色 —— 浅色主题下它接近黑、深色主题下接近白，
    // 配白色文字就会出现「白底白字」（用户实际遇到过两次）。
    const BTN_PRIMARY = {
      background: '#4d6bfe',
      color: '#ffffff',
      borderColor: '#4d6bfe',
    };
    const BTN_DANGER = {
      background: '#d64545',
      color: '#ffffff',
      borderColor: '#d64545',
    };
    const BTN_PLAIN = {
      background: 'var(--dsw-alias-interactive-bg-hover-solid,rgba(38,49,72,.08))',
      color: 'var(--dsw-alias-label-primary,#1b1d22)',
      borderColor: 'var(--dsw-alias-border-l3,rgba(38,49,72,.18))',
    };

    function credGroup(key, title, children) {
      return h('section', { key, className: 'jmw-cred-group' }, [
        h('h5', { key: 'title', className: 'jmw-cred-grouptitle' }, title),
        h('div', { key: 'body', className: 'jmw-cred-groupbody' }, children.filter(Boolean)),
      ]);
    }

    function credPair(key, label, value) {
      const shown = value === undefined || value === null || value === '' ? '—' : String(value);
      return h('div', { key, className: 'jmw-cred-pair' }, [
        h('span', { key: 'k', className: 'jmw-cred-label' }, label),
        h('span', { key: 'v', className: 'jmw-cred-value' }, shown),
      ]);
    }

    function credSwitch(key, label, checked, onChange, disabled) {
      return h('label', { key, className: 'jmw-cred-switch' }, [
        h('input', {
          key: 'i',
          type: 'checkbox',
          checked: checked === true,
          disabled: disabled === true,
          onChange: (event) => onChange(event?.target?.checked === true),
        }),
        h('span', { key: 't', className: 'jmw-cred-switchlabel' }, label),
      ]);
    }

    function CredentialSettings(props) {
      const view = props?.view === 'summary' ? 'summary' : 'page';
      const [state, setState] = React.useState({
        loading: true,
        status: null,
        watch: null,
        writable: true,
        // 表单里的三个可改字段：间隔用「秒」展示，保存时换回毫秒。
        form: { watchEnabled: true, watchIntervalMs: 60000, notify: true, maxResults: LIMIT_DEFAULT },
        input: '',
        // 账号邮箱是可改字段，和令牌一起保存（Basic 认证 = 邮箱 + 令牌）。
        email: '',
        emailTouched: false,
        busy: '',
        message: '',
        error: '',
        watchMessage: '',
        watchError: '',
        watchBusy: false,
        // 配置文件（当前 profile 的 cordis.patch.yml）：路径信息、打开动作与提示。
        patch: null,
        openBusy: '',
        // 「用指定应用打开」输入框的内容（应用名或完整路径）。
        customApp: '',
        patchMessage: '',
        patchError: '',
        copied: false,
        confirming: false,
      });
      let watchDebounce = null;
      let watchFlashTimer = null;
      let patchFlashTimer = null;

      function readWatch(payload, previous) {
        const watch = payload?.watch ?? previous?.watch ?? null;
        const fallback = previous?.form ?? { watchEnabled: true, watchIntervalMs: 60000, notify: true, maxResults: LIMIT_DEFAULT, language: 'auto' };
        const next = watch
          ? {
            watchEnabled: watch.watchEnabled !== false,
            watchIntervalMs: Number(watch.watchIntervalMs) || fallback.watchIntervalMs,
            notify: watch.notify !== false,
            // 0 是合法值（= 不限制）：不能用 `Number(x) || 默认` 那种写法，会把 0 吞成默认。
            maxResults: Number.isFinite(Number(watch.maxResults)) ? normalizeLimit(watch.maxResults, fallback.maxResults) : fallback.maxResults,
            language: ['auto', 'zh', 'en'].includes(watch.language) ? watch.language : (fallback.language ?? 'auto'),
          }
          : { ...fallback };
        return {
          watch,
          writable: payload?.writable ?? previous?.writable ?? true,
          form: next,
          patch: payload?.patch ?? previous?.patch ?? null,
        };
      }

      async function refresh() {
        try {
          const response = await watchFetch(CREDENTIAL_PATH, { method: 'GET', headers: { accept: 'application/json' } });
          const payload = await response.json().catch(() => null);
          if (payload?.ok !== true) throw new Error(payload?.error || `HTTP ${response.status}`);
          setState((prev) => ({
            ...prev,
            loading: false,
            status: payload,
            // 用户正在输入时不要用服务器值覆盖他手里的内容。
            email: prev.emailTouched ? prev.email : String(payload.email ?? ''),
            error: '',
          }));
        } catch (error) {
          setState((prev) => ({ ...prev, loading: false, error: t('credLoadFailed', { message: String(error?.message ?? error) }) }));
        }
        try {
          const response = await watchFetch(SETTINGS_PATH, { method: 'GET', headers: { accept: 'application/json' } });
          const payload = await response.json().catch(() => null);
          if (payload?.ok !== true) throw new Error(payload?.error || `HTTP ${response.status}`);
          setState((prev) => ({ ...prev, ...readWatch(payload, prev), watchError: '' }));
        } catch (error) {
          setState((prev) => ({ ...prev, watchError: t('watchLoadFailed', { message: String(error?.message ?? error) }) }));
        }
      }

      React.useEffect(() => {
        void refresh();
      }, []);

      async function save() {
        // 令牌与邮箱是一对：有令牌就用新令牌，没令牌时用当前生效的那把（只改邮箱的场景）。
        const token = state.input.trim();
        const email = state.email.trim();
        if (!token && !emailChanged()) return;
        setState((prev) => ({ ...prev, busy: 'save', message: '', error: '' }));
        try {
          const response = await watchFetch(CREDENTIAL_PATH, {
            method: 'POST',
            headers: { accept: 'application/json', 'content-type': 'application/json' },
            body: JSON.stringify({ token, email }),
          });
          const payload = await response.json().catch(() => null);
          if (payload?.ok !== true) throw new Error(payload?.error || `HTTP ${response.status}`);
          const offline = payload.verification && payload.verification.ok === false;
          const account = payload.verification?.account ? `　${t('credSavedAs', { account: payload.verification.account })}` : '';
          const emailNote = payload.emailSaved ? `　${t('credSavedEmail', { email: payload.email ?? email })}` : '';
          setState((prev) => ({
            ...prev,
            busy: '',
            input: '',
            email: String(payload.email ?? prev.email),
            emailTouched: false,
            status: payload,
            error: '',
            // 账号只跟着这次保存的消息显示；不要把验证结果留在 state 里，否则下一条消息也会挂上它。
            message: (offline
              ? t('credSavedOffline', { key: payload.credentialKey, message: payload.verification.message ?? '' })
              : t('credSaved', { key: payload.credentialKey })) + emailNote + account,
          }));
        } catch (error) {
          setState((prev) => ({ ...prev, busy: '', error: t('credSaveFailed', { message: String(error?.message ?? error) }) }));
        }
      }

      // 邮箱是否真的变了（和服务端原文比），决定「只改邮箱」时按钮是否可用。
      function emailChanged() {
        const current = String(state.status?.email ?? '').trim();
        return state.email.trim() !== current;
      }

      // 监视设置「改了就生效」：开关一拨、间隔一改就写进当前 profile 的 Cordis patch，
      // 不需要「保存」按钮（只有令牌那种敏感值才需要显式确认后再落库）。
      async function pushWatch(patch) {
        const next = { ...state.form, ...patch };
        const seconds = Math.max(15, Math.round((Number(next.watchIntervalMs) || 60000) / 1000));
        const results = normalizeLimit(next.maxResults, LIMIT_DEFAULT);
        const payloadBody = {
          watchEnabled: next.watchEnabled === true,
          watchIntervalMs: seconds * 1000,
          notify: next.notify === true,
          maxResults: results,
          language: ['zh', 'en'].includes(next.language) ? next.language : 'auto',
        };
        clearTimeout(watchFlashTimer);
        setState((prev) => ({ ...prev, form: { ...prev.form, ...patch }, watchBusy: true, watchMessage: '', watchError: '' }));
        try {
          const response = await watchFetch(SETTINGS_PATH, {
            method: 'POST',
            headers: { accept: 'application/json', 'content-type': 'application/json' },
            body: JSON.stringify(payloadBody),
          });
          const payload = await response.json().catch(() => null);
          if (payload?.ok !== true) throw new Error(payload?.error || `HTTP ${response.status}`);
          setState((prev) => ({
            ...prev,
            watchBusy: false,
            ...readWatch(payload, prev),
            watchError: '',
            watchMessage: payload.persisted === true
              ? t('watchSaved')
              : t('watchSavedLocal', { reason: payload.reason ?? '' }),
          }));
          watchFlashTimer = setTimeout(() => setState((prev) => ({ ...prev, watchMessage: '' })), 2600);
          if (typeof watchFlashTimer?.unref === 'function') watchFlashTimer.unref();
        } catch (error) {
          // 失败就把界面回退成服务器上的值，别让人以为已经生效了。
          setState((prev) => ({
            ...prev,
            watchBusy: false,
            ...readWatch(null, prev),
            watchMessage: '',
            watchError: t('credSaveFailed', { message: String(error?.message ?? error) }),
          }));
        }
      }

      // 「打开 cordis.patch.yml」：全部交给 host 去执行（它才有系统级能力）。
      // default = 系统默认程序；choose = 系统「打开方式」选择器（macOS / Windows）；
      // reveal = 在文件管理器里定位到该文件；app = 用探测到的某个编辑器；
      // custom = 用用户手填的应用名 / 完整路径。app 会把应用作为第二个参数带上。
      async function openPatch(mode, app) {
        const target = state.patch?.patchPath;
        if (!target) return;
        const body = typeof app === 'string' && app ? { open: mode, app } : { open: mode };
        setState((prev) => ({ ...prev, openBusy: mode, patchMessage: '', patchError: '' }));
        try {
          const response = await watchFetch(SETTINGS_PATH, {
            method: 'POST',
            headers: { accept: 'application/json', 'content-type': 'application/json' },
            body: JSON.stringify(body),
          });
          const payload = await response.json().catch(() => null);
          if (payload?.ok !== true) throw new Error(payload?.error || `HTTP ${response.status}`);
          const name = String(payload?.app ?? app ?? '');
          // app 模式回的是编辑器 id，提示里说给人看的 label（例如 vscode → VS Code）。
          const shown = mode === 'app'
            ? ((state.patch?.editors ?? []).find((row) => row?.id === name)?.label ?? name)
            : name;
          setState((prev) => ({
            ...prev,
            openBusy: '',
            // app / custom 用「已交给 {app} 打开」，其余沿用原来的三种文案。
            patchMessage: mode === 'reveal'
              ? t('patchRevealed')
              : (mode === 'choose'
                ? t('patchChooseSent')
                : (name && (mode === 'app' || mode === 'custom') ? t('patchOpenedApp', { app: shown }) : t('patchOpened'))),
            // app 成功后本地就把「上次用过」标到刚点的那个按钮上（等下一次 GET 会自然同步）。
            patch: mode === 'app' && prev.patch ? { ...prev.patch, preferredEditor: app } : prev.patch,
            // custom 成功后清空输入框，方便直接换下一个应用。
            customApp: mode === 'custom' ? '' : prev.customApp,
          }));
          clearTimeout(patchFlashTimer);
          patchFlashTimer = setTimeout(() => setState((prev) => ({ ...prev, patchMessage: '' })), 2600);
          if (typeof patchFlashTimer?.unref === 'function') patchFlashTimer.unref();
        } catch (error) {
          setState((prev) => ({ ...prev, openBusy: '', patchError: t('patchFailed', { message: String(error?.message ?? error) }) }));
        }
      }

      // 路径可能又长又不方便手抄：优先用剪贴板 API，老壳里退回 execCommand。
      async function copyPath() {
        const text = String(state.patch?.patchPath ?? '');
        if (!text) return;
        let ok = false;
        try {
          if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            ok = true;
          }
        } catch {
          ok = false;
        }
        if (!ok && typeof document !== 'undefined' && typeof document.createElement === 'function') {
          try {
            const area = document.createElement('textarea');
            area.value = text;
            area.setAttribute?.('readonly', 'readonly');
            document.body?.appendChild?.(area);
            area.select?.();
            ok = typeof document.execCommand === 'function' && document.execCommand('copy') === true;
            document.body?.removeChild?.(area);
          } catch {
            ok = false;
          }
        }
        setState((prev) => ({ ...prev, copied: ok, patchError: ok ? '' : t('patchCopyFailed') }));
        if (ok) {
          clearTimeout(patchFlashTimer);
          patchFlashTimer = setTimeout(() => setState((prev) => ({ ...prev, copied: false })), 2600);
          if (typeof patchFlashTimer?.unref === 'function') patchFlashTimer.unref();
        }
      }

      // 间隔用 debounce：连着敲「30」不要发两次写入；失焦 / 回车立刻落盘。
      /** 界面语言：auto = 跟随 DSH 语言设置 / 浏览器，zh 与 en 强制；改了就生效。 */
      function chooseLanguage(value) {
        const next = ['auto', 'zh', 'en'].includes(value) ? value : 'auto';
        setState((prev) => ({ ...prev, form: { ...prev.form, language: next } }));
        void pushWatch({ language: next });
      }

      function langChip(value, label) {
        const on = (state.form.language ?? 'auto') === value;
        return h('button', {
          key: `lang-${value}`,
          type: 'button',
          className: `jmw-chip pick${on ? ' cur' : ''}`,
          'aria-pressed': on,
          onClick: () => chooseLanguage(value),
        }, label);
      }

      function readResults(text, immediate) {
        // 空串（正在清空输入框）不动当前值；**0 是合法值 = 不限制**，不能像旧版那样吞掉。
        const raw = String(text ?? '').trim();
        const results = raw === '' ? state.form.maxResults : normalizeLimit(raw, state.form.maxResults);
        clearTimeout(watchDebounce);
        setState((prev) => ({ ...prev, form: { ...prev.form, maxResults: results } }));
        if (immediate) {
          void pushWatch({ maxResults: results });
          return;
        }
        watchDebounce = setTimeout(() => { void pushWatch({ maxResults: results }); }, 700);
        if (typeof watchDebounce?.unref === 'function') watchDebounce.unref();
      }

      function changeInterval(text, immediate) {
        const value = Number(text);
        const intervalMs = Number.isFinite(value) && value > 0 ? Math.round(value * 1000) : state.form.watchIntervalMs;
        clearTimeout(watchDebounce);
        setState((prev) => ({ ...prev, form: { ...prev.form, watchIntervalMs: intervalMs } }));
        if (immediate) {
          void pushWatch({ watchIntervalMs: intervalMs });
          return;
        }
        watchDebounce = setTimeout(() => { void pushWatch({ watchIntervalMs: intervalMs }); }, 700);
        if (typeof watchDebounce?.unref === 'function') watchDebounce.unref();
      }

      async function clear() {
        if (!state.confirming) {
          setState((prev) => ({ ...prev, confirming: true }));
          return;
        }
        setState((prev) => ({ ...prev, busy: 'clear', confirming: false, message: '', error: '' }));
        try {
          const response = await watchFetch(CREDENTIAL_PATH, {
            method: 'POST',
            headers: { accept: 'application/json', 'content-type': 'application/json' },
            body: JSON.stringify({ clear: true }),
          });
          const payload = await response.json().catch(() => null);
          if (payload?.ok !== true) throw new Error(payload?.error || `HTTP ${response.status}`);
          setState((prev) => ({ ...prev, busy: '', status: payload, error: '', message: t('credCleared', { key: payload.credentialKey }) }));
        } catch (error) {
          setState((prev) => ({ ...prev, busy: '', error: t('credClearFailed', { message: String(error?.message ?? error) }) }));
        }
      }

      const status = state.status;
      const settings = status?.settings ?? {};
      const patchFile = state.patch;
      const seconds = Math.max(15, Math.round((Number(state.form.watchIntervalMs) || 60000) / 1000));

      if (view === 'summary') {
        if (state.error && !status) return h('span', { className: 'jmw-cred-summary err' }, state.error);
        if (!status) return h('span', { className: 'jmw-cred-summary' }, t('credTitle'));
        return h('span', { className: 'jmw-cred-summary' }, status.configured
          ? t('credSummarySet', { masked: status.masked })
          : t('credSummaryMissing'));
      }

      return h('section', { className: 'jmw-cred' }, [
        credGroup('ui', t('uiTitle'), [
          h('div', { key: 'lang', className: 'jmw-cred-lang' }, [
            h('span', { key: 'label', className: 'jmw-cred-langlabel' }, t('uiLanguageLabel')),
            h('div', { key: 'chips', className: 'jmw-cred-langchips' }, [
              langChip('auto', t('uiAuto')),
              langChip('zh', t('uiZh')),
              langChip('en', t('uiEn')),
            ]),
          ]),
          h('p', { key: 'hint', className: 'jmw-cred-hint' }, t('uiHint')),
        ]),
        credGroup('token', t('credGroupToken'), [
          h('div', { key: 'current', className: 'jmw-cred-row' }, [
            h('span', { key: 'label', className: 'jmw-cred-label' }, t('credCurrent')),
            status?.configured
              ? h('code', { key: 'masked', className: 'jmw-cred-masked' }, status.masked)
              : h('span', { key: 'none', className: 'jmw-cred-none' }, t('credNotSet')),
          ]),
          status ? h('div', { key: 'source', className: 'jmw-cred-note' }, t('credSource', { source: status.sourceLabel })) : null,
          status ? h('div', { key: 'key', className: 'jmw-cred-note' }, `${t('credKeyLabel')}：${t('credKeyValue', { key: status.credentialKey })}`) : null,
          h('div', { key: 'form', className: 'jmw-cred-form' }, [
            h('label', { key: 'emailLabel', className: 'jmw-cred-label', htmlFor: 'jmw-cred-email' }, t('credEmailLabel')),
            h('input', {
              key: 'email',
              id: 'jmw-cred-email',
              className: 'jmw-cred-email',
              type: 'text',
              inputMode: 'email',
              autoComplete: 'off',
              spellCheck: false,
              placeholder: 'name@company.com',
              value: state.email,
              onInput: (event) => setState((prev) => ({ ...prev, email: event?.target?.value ?? '', emailTouched: true })),
            }),
            h('div', { key: 'emailHint', className: 'jmw-cred-hint' }, t('credEmailHint')),
            h('label', { key: 'label', className: 'jmw-cred-label', htmlFor: 'jmw-cred-input' }, t('credInputLabel')),
            h('input', {
              key: 'input',
              id: 'jmw-cred-input',
              className: 'jmw-cred-input',
              type: 'password',
              autoComplete: 'off',
              spellCheck: false,
              placeholder: t('credPlaceholder'),
              value: state.input,
              onInput: (event) => setState((prev) => ({ ...prev, input: event?.target?.value ?? '' })),
            }),
            h('div', { key: 'actions', className: 'jmw-cred-actions' }, [
              h('button', {
                key: 'save',
                type: 'button',
                className: 'jmw-cred-btn primary',
                style: BTN_PRIMARY,
                disabled: state.busy === 'save' || state.email.trim() === ''
                  || (state.input.trim() === '' && !emailChanged()),
                onClick: () => { void save(); },
              }, state.busy === 'save' ? t('credSaving') : t('credSave')),
              h('button', {
                key: 'clear',
                type: 'button',
                className: `jmw-cred-btn${state.confirming ? ' danger' : ''}`,
                style: state.confirming ? BTN_DANGER : BTN_PLAIN,
                disabled: state.busy === 'clear',
                onClick: () => { void clear(); },
              }, state.confirming ? t('credConfirmClear') : t('credClear')),
            ]),
          ]),
          state.message ? h('div', { key: 'message', className: 'jmw-cred-msg ok' }, state.message) : null,
          state.error ? h('div', { key: 'error', className: 'jmw-cred-msg err' }, state.error) : null,
          h('div', { key: 'note', className: 'jmw-cred-note' }, t('credNote')),
          h('a', { key: 'tokens', className: 'jmw-cred-link', href: TOKENS_URL, target: '_blank', rel: 'noreferrer' }, t('credTokensLink')),
        ]),
        credGroup('connection', t('credGroupConnection'), [
          credPair('baseUrl', t('fBaseUrl'), settings.baseUrl),
        ]),
        credGroup('query', t('credGroupQuery'), [
          h('div', { key: 'results', className: 'jmw-cred-row' }, [
            h('label', { key: 'label', className: 'jmw-cred-label', htmlFor: 'jmw-results' }, t('resultsLabel')),
            h('input', {
              key: 'input',
              id: 'jmw-results',
              className: 'jmw-cred-input jmw-cred-num',
              type: 'number',
              // 0 = 不限制（默认）；正数 10–5000。min 必须是 0，否则浏览器原生校验会拦住「0」。
              min: '0',
              max: String(LIMIT_MAX),
              step: '10',
              value: String(state.form.maxResults ?? LIMIT_DEFAULT),
              onInput: (event) => readResults(event?.target?.value, false),
              onChange: (event) => readResults(event?.target?.value, true),
              onBlur: (event) => readResults(event?.target?.value, true),
              onKeyDown: (event) => {
                if (event?.key === 'Enter') readResults(event?.target?.value, true);
              },
            }),
            h('span', { key: 'unit', className: 'jmw-cred-unit' }, t('resultsUnit')),
          ]),
          h('div', { key: 'resultsHint', className: 'jmw-cred-hint' }, t('resultsHint')),
          credPair('timeout', t('fTimeout'), settings.timeoutMs === undefined ? undefined : `${settings.timeoutMs} ms`),
        ]),
        credGroup('watch', t('credGroupWatch'), [
          credSwitch('enabled', t('watchEnabledLabel'), state.form.watchEnabled, (checked) => {
            void pushWatch({ watchEnabled: checked });
          }, state.watchBusy === true),
          h('div', { key: 'interval', className: 'jmw-cred-row' }, [
            h('label', { key: 'label', className: 'jmw-cred-label', htmlFor: 'jmw-watch-interval' }, t('watchIntervalLabel')),
            h('input', {
              key: 'input',
              id: 'jmw-watch-interval',
              className: 'jmw-cred-input jmw-cred-num',
              type: 'number',
              min: '15',
              step: '5',
              value: String(seconds),
              onInput: (event) => changeInterval(event?.target?.value, false),
              onChange: (event) => changeInterval(event?.target?.value, true),
              onBlur: (event) => changeInterval(event?.target?.value, true),
              onKeyDown: (event) => {
                if (event?.key === 'Enter') changeInterval(event?.target?.value, true);
              },
            }),
            h('span', { key: 'unit', className: 'jmw-cred-unit' }, t('watchIntervalUnit')),
          ]),
          h('div', { key: 'intervalHint', className: 'jmw-cred-hint' }, t('watchIntervalHint')),
          credSwitch('notify', t('notifySwitchLabel'), state.form.notify, (checked) => {
            void pushWatch({ notify: checked });
          }, state.watchBusy === true),
          state.writable === false ? h('div', { key: 'writable', className: 'jmw-cred-hint warn' }, t('writableOff')) : null,
          state.watchBusy === true ? h('div', { key: 'busy', className: 'jmw-cred-note' }, t('watchSaving')) : null,
          state.watchMessage ? h('div', { key: 'watchMessage', className: 'jmw-cred-msg ok' }, state.watchMessage) : null,
          state.watchError ? h('div', { key: 'watchError', className: 'jmw-cred-msg err' }, state.watchError) : null,
        ]),
        credGroup('patch', t('patchTitle'), [
          h('div', { key: 'path', className: 'jmw-cred-row' }, [
            h('span', { key: 'label', className: 'jmw-cred-label' }, t('patchPathLabel')),
            h('code', { key: 'value', className: 'jmw-cred-path' }, patchFile?.patchPath || t('patchMissingPath')),
          ]),
          patchFile?.patchPath
            ? h('div', { key: 'pathActions', className: 'jmw-cred-actions' }, [
              h('button', {
                key: 'copy',
                type: 'button',
                className: 'jmw-cred-btn',
                style: BTN_PLAIN,
                onClick: () => { void copyPath(); },
              }, state.copied ? t('patchCopied') : t('patchCopy')),
            ])
            : null,
          patchFile?.patchPath
            ? h('div', { key: 'actions', className: 'jmw-cred-actions' }, [
              h('button', {
                key: 'open',
                type: 'button',
                className: 'jmw-cred-btn primary',
                style: BTN_PRIMARY,
                disabled: state.openBusy !== '' || patchFile.patchExists === false,
                onClick: () => { void openPatch('default'); },
              }, t('patchOpen')),
              patchFile.canChoose === true
                ? h('button', {
                  key: 'choose',
                  type: 'button',
                  className: 'jmw-cred-btn',
                  style: BTN_PLAIN,
                  disabled: state.openBusy !== '',
                  onClick: () => { void openPatch('choose'); },
                }, t('patchChoose'))
                : null,
              h('button', {
                key: 'reveal',
                type: 'button',
                className: 'jmw-cred-btn',
                style: BTN_PLAIN,
                disabled: state.openBusy !== '' || patchFile.patchExists === false,
                onClick: () => { void openPatch('reveal'); },
              }, t('patchReveal')),
            ])
            : null,
          // 编辑器直选：只画 host 探测到的那几个（探不到就不画，免得点了必然报错）。
          patchFile?.patchPath
            ? h('div', { key: 'editors', className: 'jmw-cred-form' }, [
              h('div', { key: 'editorsLabel', className: 'jmw-cred-label' }, t('patchEditors')),
              (patchFile.editors ?? []).length
                ? h('div', { key: 'editorsRow', className: 'jmw-cred-actions' }, (patchFile.editors ?? []).map((editor) => {
                  const preferred = Boolean(editor) && editor.id === patchFile.preferredEditor;
                  return h('button', {
                    key: `editor-${editor?.id}`,
                    type: 'button',
                    className: `jmw-cred-btn${preferred ? ' primary' : ''}`,
                    style: preferred ? BTN_PRIMARY : BTN_PLAIN,
                    disabled: state.openBusy !== '' || patchFile.patchExists === false,
                    onClick: () => { void openPatch('app', String(editor?.id ?? '')); },
                  }, `${editor?.label ?? ''}${preferred ? t('patchEditorPreferred') : ''}`);
                }))
                : h('div', { key: 'editorsNone', className: 'jmw-cred-hint' }, t('patchNoEditors')),
            ])
            : null,
          // 自由输入：应用名或完整路径，作为**一个** argv 参数交给 host（host 不拼 shell）。
          patchFile?.patchPath
            ? h('div', { key: 'custom', className: 'jmw-cred-form' }, [
              h('label', { key: 'customLabel', className: 'jmw-cred-label', htmlFor: 'jmw-cred-custom-app' }, t('patchCustomLabel')),
              h('input', {
                key: 'customInput',
                id: 'jmw-cred-custom-app',
                className: 'jmw-cred-input',
                type: 'text',
                autoComplete: 'off',
                spellCheck: false,
                placeholder: t('patchCustomPlaceholder'),
                value: state.customApp,
                onInput: (event) => setState((prev) => ({ ...prev, customApp: event?.target?.value ?? '' })),
              }),
              h('div', { key: 'customActions', className: 'jmw-cred-actions' }, [
                h('button', {
                  key: 'customOpen',
                  type: 'button',
                  className: 'jmw-cred-btn',
                  style: BTN_PLAIN,
                  disabled: state.openBusy !== '' || String(state.customApp ?? '').trim() === ''
                    || patchFile.patchExists === false,
                  onClick: () => { void openPatch('custom', String(state.customApp ?? '').trim()); },
                }, t('patchCustomOpen')),
              ]),
            ])
            : null,
          patchFile && patchFile.patchExists === false
            ? h('div', { key: 'missing', className: 'jmw-cred-hint warn' }, t('patchMissingFile'))
            : null,
          h('div', { key: 'hint', className: 'jmw-cred-hint' }, t('patchHint')),
          state.patchMessage ? h('div', { key: 'message', className: 'jmw-cred-msg ok' }, state.patchMessage) : null,
          state.patchError ? h('div', { key: 'error', className: 'jmw-cred-msg err' }, state.patchError) : null,
        ]),
        h('div', { key: 'other', className: 'jmw-cred-note' }, t('credOther')),
      ]);
    }

    /* -------------------------------------------------------------- 装配 */

    return {
      inject: ['slots', 'remote'],
      apply(ctx) {
        runtime.ctx = ctx;

        const styleOff = injectStyle();
        if (typeof ctx.effect === 'function') ctx.effect(() => styleOff, 'jira-work-overview: stylesheet');

        const locale = typeof ctx.get === 'function' ? ctx.get('locale') : undefined;
        if (locale && typeof locale.register === 'function') {
          try {
            locale.register(NS, { zh: M.zh, en: M.en });
            const bound = typeof locale.bind === 'function' ? locale.bind(NS) : undefined;
            const translate = typeof bound === 'function' ? bound : (bound?.t ?? bound?.translate);
            if (typeof translate === 'function') hostLocale = (key, params) => translate(key, params);
            // 语言服务是权威来源：先取当前值（设置 → 通用 → 语言），再跟着切换重渲染。
            const active = typeof locale.getSnapshot === 'function' ? locale.getSnapshot()?.active : undefined;
            setLanguage(active ?? '');
          } catch {
            hostLocale = undefined;
          }
        }
        // 切语言时重渲染，并且下一次请求会把新语言带给 host 半边，两边文案保持一致。
        if (typeof ctx.on === 'function') {
          try {
            ctx.on('locale/change', (current) => setLanguage(current?.active ?? current));
          } catch {
            // 没有这个事件也不影响：面板仍按浏览器语言渲染。
          }
        }

        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action',
          id: ENTRY_ID,
          order: 30,
          label: () => t('title'),
        }, Entry));

        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: PANEL_ID,
          order: 30,
          label: () => t('title'),
        }, Panel));

        // 插件详情页上的配置区（slots: plugins.bundle.config，key 是包名）——
        // 这是最容易找到的入口：插件列表点进「Jira work overview」就能看到「Jira 令牌」这一段。
        ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
          name: 'plugins.bundle.config',
          key: PLUGIN_ID,
          order: 30,
          locale: NS,
          label: () => t('credTitle'),
        }, CredentialSettings));

        // 以及 bundle 里那一行自己的配置页（slots: plugins.row.config，key 是 `<包名>#<row id>`）：
        // 注册后该行的标题会变成可点按钮（带一个 chevron），点进去是同一个组件。
        ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
          name: 'plugins.row.config',
          key: ROW_CONFIG_KEY,
          order: 30,
          locale: NS,
          label: () => t('credTitle'),
        }, CredentialSettings));

        // 左栏「工作区」行的右键菜单：关联 / 取消关联 Jira 项目。
        // 结构化菜单是抽象贡献（不是 React 组件），只能注册在 dsh-client-ui-context-menu 的
        // `contextMenus` 服务上。**这个服务不保证在本插件 apply 时已经就绪**：浏览器侧的插件入口
        // 是并发创建的，本插件只 inject 了 slots / remote，而 contextMenus 自己还要等 locale、
        // shortcuts（0.16.1 及以前这里直接 ctx.get 一次，拿到 undefined 就整页都没有这条菜单 ——
        // 「关联 Jira 项目…」随机消失就是这么来的）。现在用 ctx.inject 等它出现再注册；
        // 老基座没有 ctx.inject 时退回直接注册。
        function registerWorkspaceProjectMenu(host) {
          const contextMenus = typeof host.get === 'function' ? host.get('contextMenus') : undefined;
          if (!contextMenus || typeof contextMenus.register !== 'function') return;
          try {
            host.effect?.(() => contextMenus.register({
              id: `${PLUGIN_ID}.workspace-project`,
              target: 'workspace',
              order: 500,
              observe: () => [host.get('workspaces')?.list].filter(Boolean),
              resolve: (target) => {
                const entries = [projectMenuEntry(target)];
                const unlink = projectUnlinkEntry(target);
                if (unlink) entries.push(unlink);
                return entries;
              },
            }), `${NS}: workspace project menu`);
          } catch (error) {
            console.warn(`${NS}: workspace menu unavailable`, error);
          }
        }
        if (typeof ctx.inject === 'function') {
          ctx.inject(['contextMenus'], (child) => {
            try {
              registerWorkspaceProjectMenu(child);
            } catch (error) {
              console.warn(`${NS}: workspace menu unavailable`, error);
            }
          });
        } else {
          try {
            registerWorkspaceProjectMenu(ctx);
          } catch (error) {
            console.warn(`${NS}: workspace menu unavailable`, error);
          }
        }

        // 侧栏会话行：角标（工作区关联的项目）与 hover 卡片一行。两个都是可选的洞，缺了不影响面板。
        ctx.slots.inject('sidebar.session.row.trailing', () => ctx.slots.register({
          name: 'sidebar.session.row.trailing',
          id: ENTRY_ID,
          order: 40,
          locale: NS,
          label: () => t('wsLinked', { projects: 'Jira' }),
        }, WorkspaceBadge));
        ctx.slots.inject('sidebar.session.row.hover', () => ctx.slots.register({
          name: 'sidebar.session.row.hover',
          id: ENTRY_ID,
          order: 40,
          locale: NS,
          label: () => t('wsLinked', { projects: 'Jira' }),
        }, WorkspaceHoverLine));

        // 映射要开局就有一份：会话行角标、面板开头的「本工作区」、任务行的「计划」按钮都读它。
        void fetchWorkspaceLinks();
        void fetchPlanSessions();

        startWatchLoop(ctx);
      },
    };
  },
});
