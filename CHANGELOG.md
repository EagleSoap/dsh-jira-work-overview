# Changelog

All notable changes to **dsh-jira-work-overview** are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html). The first 25 releases were built in a single day, so the dates are real but the cadence was not: each entry lists what changed, not how long it took.

## [Unreleased]

### Fixed

- **Windows：桌面通知一条都不弹。** Windows 的 Toast 必须挂在一个**已注册的** AUMID 上才能
  `Show()`；未注册时 `CreateToastNotifier()` 抛 `Element not found (0x80070490)`，而它被静默吞掉了，
  于是「新任务 / 状态变化」在 Windows 上等于没有通知。现在按 `DSH_NOTIFY_AUMID` → `DeepSeek Harness`
  → `com.deepseek.harness` → 系统自带的 Windows PowerShell AUMID 顺序逐个试，第一个成功的就停；
  脚本里的语句改用换行拼接（`{; try … }` 是 PowerShell 语法错误，之前整段都不执行）。
- **Windows：「在文件管理器中显示」明明成功了却报「打开失败」。** `explorer.exe /select,<path>` 成功时
  也返回退出码 1，之前被当成失败抛出。现在这个分支允许非零退出码（只有进程根本起不来才算失败）。
- **Windows：profile 放在网络共享盘上时，配置文件被当成「路径未知」。** 绝对路径判定除了 `/…`、
  `C:\…`，现在也认 UNC（`\\server\share\…`），「打开 / 显示 / 选择打开方式」不再提前报错。
- **Linux：编辑器只能存命令名，从桌面启动器点开会失败。** 探测编辑器时除了 `PATH` 还会查
  `/usr/local/bin`、`/usr/bin`、`/bin`、`/snap/bin`、`/var/lib/flatpak/exports/bin`、`~/.local/bin`、
  `~/.nix-profile/bin`、`~/.linuxbrew/bin` 和 JetBrains Toolbox 的 scripts 目录；只有**可执行**的才算数
  （目录跳过），并且启动时用**绝对路径**——最小 `PATH` 的桌面会话里也能点动。
- **`PATH` 的分隔符按平台取**（Windows 是 `;`，其余是 `:`）。真实 Windows 上探测编辑器走 `where`，
  这条分支实际不可达，属防御性修复。
- **Linux 的「选择打开方式」** 明确返回 `err.chooseUnsupported`（系统没有等价物），不再静默失败。
- **干净机器上跑测试会直接崩**：9 个离线套件在 `$DSH_JIRA_TMP/.dsh_jira_env` 不存在时 `ENOENT`
  退出 1。现在缺文件就建一个空的（`0o600`），目录不存在就先 `mkdirSync(…, { recursive: true })`。
- **`test/dsh-jira-transition.mjs` 在没有站点凭据时**抛 `JiraError: No Jira site URL yet: …` 并退出 1
  （违反「测试必须 SKIP」）。现在先跑两个不碰网络的 400 断言，之后打印
  `SKIP: 没有 JIRA_BASE_URL / JIRA_API_TOKEN` 并 `exit 0`。
- **出图脚本不再写死 macOS 的 Chrome / `app.asar` 路径**：`DSH_JIRA_CHROME` / `DSH_JIRA_ASAR` 优先，
  然后按平台找（Windows 的 `%ProgramFiles%` / `%LOCALAPPDATA%`，Linux 的 `/usr/bin/google-chrome`、
  `google-chrome-stable`、`chromium`、`chromium-browser`、snap、flatpak）；`file://` 拼接改成
  `pathToFileURL()`（Windows 上 `file://C:\…` 是非法 URL）；root 用户自动加 `--no-sandbox`（容器 / CI）。

### Testing & CI

- **新增 `test/dsh-jira-platform.mjs`（31 项）**：强制 `process.platform` 走 win32 / linux / freebsd 分支，
  把 `#!/bin/sh` 假可执行文件（`cmd.exe`、`explorer.exe`、`rundll32.exe`、`powershell.exe`、`where`、
  `xdg-open`、`notify-send`）放到 `PATH` 最前，断言**真 spawn 出来的命令与参数**。Windows / Linux 的
  命令行分派第一次有了自动化覆盖：`cmd /c start` 的引号、`explorer /select,`、`rundll32` 打开方式、
  Toast 脚本内容（AUMID 顺序、单引号转义、UTF-16LE base64 往返）、UNC 路径、`:` 与 `;` 的切分。
- **新增 `test/lib-host-runtime.mjs` 的 `prepareHostCopy()`**：宿主依赖统一从 `DSH_INSTALL_DIR` 拷，
  拿不到就 `SKIP: …` + `exit 0`——14 个套件共用，`plan` 套件里 1200 多字的重复拷贝块删掉。
- **新增 `test/run-offline.mjs`**：一条命令跑完 17 个套件（`--release` 会透传给发版预检）。
- **新增 `.github/workflows/test.yml`**：Ubuntu / macOS / Windows 三平台矩阵，每次 push / PR 跑整套离线
  测试（public 仓库的 GitHub Actions 免费）。**机器上没装 DSH 也能跑**：从 npm 装
  `@deepseek-ai/schemastery` + `cosmokit`，拼一个假 `DSH_INSTALL_DIR` 交给 `prepareHostCopy()`。
- **新增发版预检 `test/dsh-jira-release.mjs` + `.github/workflows/release-check.yml`**（常规 48 项 /
  `--release` 50 项）：版本号 ⇄ `CHANGELOG.md` ⇄ tag 一致、`[Unreleased]` 已清空、bundle 身份三处一致、
  仓库里没有个人数据、`npm pack` 的真实 tarball 清单与 `files` 一致；`publish.yml` 在 `npm publish`
  之前跑同一预检——内容不自洽就红在发布之前，而不是发出去之后才发现。

### Docs

- 两版 README 新增「版本与升级」（29 个版本的逐版历史表 + 升级方式）与「修复记录」（用户可感知的缺陷
  与排查顺序），并补「平台支持（macOS / Windows / Linux）」的如实口径：Linux 已实现但未在实机验证、
  「选择打开方式」是唯一缺口、文件管理器显示退化为打开父目录。
- 两版 README 加 CI 徽章；`test/README.md` 记录运行方式、`prepareHostCopy`、Chrome / `app.asar` 探测。


## [0.16.0] - 2026-11-20

### Added

- **任务行的「计划」按钮：在项目绑定的工作区里开一条 plan 模式会话。** 每条任务末尾多一个 `☰ 计划`，
  点一下就在该项目关联的工作区里新建一条会话，先 `/plan` 再把这单任务投给它——第一条消息只要求
  「列出将要执行的修改任务」，由用户在对话里敲定或修改；已经计划过的任务按钮标成已绑定（`on`），
  再点只打开原来那条，不会重复建。Jira 卡信息不全（没有标题 / 描述 / 父任务与关联）时，第一条消息会
  明确要求中断并提示「Jira 任务不明确，无法进行任务」，并列出缺什么。
  - **一条任务只对应一条计划对话**：绑定存在 volatile 配置 `planSessions`（一行一条
    `ISSUE<TAB>sessionId`）。本地映射丢了（换浏览器、清过配置）也不要紧——每条计划对话的第一条消息
    都带 `JIRA_PLAN_SESSION:<KEY>` 标记，host 直接翻会话日志找它并补回绑定；会话日志是唯一真相，
    配置只是它的缓存。
  - 没绑工作区、profile 里没配 plan 模式（`deepseek-ai/dsh-plan-mode` 的 `section`）时直接报错说明，
    不建半成品会话；刚建出来的会话在宿主注册完 agent 前会报 `session/not-found`，投递按退避重试。
  - Host：新增第 6 条通道 `/api/jira-work-overview/plan`（`GET` 读映射；`POST` 的 `create` / `search` /
    `link` / `unlink` / `clear`），`planIssueGaps` / `planFirstMessage` / `findPlanSessionByToken` /
    `createPlanSession`；字典新增 `plan.*` / `err.plan*` / `note.plan*` / `config.planSessions`。
  - Client：任务行按钮、失败横幅、`startPlan`（先查本地绑定 → 再让 host 按标记搜 → 最后才新建），
    字典新增 `planButton` / `planBusy` / `planNoWorkspace` / `planNoPolicy` / `planFailed` /
    `planCreated` / `planOpened` / `planNoSession` / `planIssueLine` / `planRules`（zh + en）。
  - 测试：新增 `test/dsh-jira-plan.mjs`（离线 24 项，真 `index.js` + 真 `client.js`，Jira / remote /
    workspace / agents / settings 全是桩）：建在绑定的工作区、`/plan` 先于第一条消息、首条消息带标记与
    「只汇报 / 不明确就中断」两条规则、二次点击不新建、按标记找回、缺口清单、参数报错、面板按钮与
    `on` 状态。
- **删掉一条计划对话**：已计划过的任务行在「计划」旁多一个 `×`，点了走基座的工作区归档
  （`remote.workspace.archiveSession`，与侧栏右键「归档」同一条通道）并清掉绑定；这一行回到未计划状态，
  再点「计划」是新建一条。host 路由 `POST /api/jira-work-overview/plan` 新增 `drop` 动作。
- 计划要求的第 5 条：列完任务后必须用 `ask_user_question` 收尾（「按这份计划执行 / 我要修改计划」），
  确认只需点一下，不用打字。

### Fixed

- **「×」报 `归档计划对话失败：no workspaces service` / `这个 profile 没有提供工作区归档通道`**：两处都取错了门。
  `ctx.get('workspaces')` 拿不到东西——注册表在服务树上的名字是 `workspaceRegistry`（`dsh-workspace` 的
  `super(ctx, "workspaceRegistry")`）；遥控命名空间也不是 `workspaces` 而是 **`workspace`**
  （`workspaceController` 的 `super(ctx, "workspaceController", { namespace: "workspace" })`，端点键
  `workspace/archiveSession`）。现在走 `remote.workspace.archiveSession({ sessionId, stopActivity: true })`，
  现在依次试三道门面：`remote.workspace.archiveSession` → **工作区注册表本体** `workspaceRegistry.archiveSession`
  （宿主的 `Connection` 根本没有 `call`，面板那套遥控又常常不暴露 `workspace` 命名空间——注册表本体才是
  真机上唯一稳定的一挡）→ `connection.call('workspace/archiveSession', …)`。三道都没有才报「没有归档通道」。
- 删掉计划对话后再点「计划」会打开那条已归档的会话：面板取绑定时带 `force: true`，
  host 只回映射、不再翻会话日志，另在 host 现建的路径上也带 `skipToken: true`。
- **「计划」建会话改走 `sessions` 会话服务，不再直连 `remote.session`**：插件没在 `ctx.inject` 里声明
  `remote`，真机上一点就抛 `cannot get property "remote.session" without inject`。现在用基座客户端常驻的
  `sessions.create({ workspaceId })` 建会话，再用 `sessions.using(id, …)` 拿会话对象、依次 `command('/plan')`
  与 `prompt([…], 'queue', …, requestId)`（与聊天框同一条路：CATALOG 立刻更新、新会话可当场落位）。
- **「计划」不再要求 profile 里装 plan 模式插件**：点在没装 `@deepseek-ai/dsh-plan-mode`（或其 `section`
  为空）的 profile 上会直接报「这个 profile 没有配置 plan 模式的工作方式」。现在口径按
  settings 覆盖 → 面板宿主配置视图 → 靴子数据里的 profile 行依次取；都没有时由第一条消息自带一份
  「只做规划、只列修改任务、敲定后再执行」的兜底口径，按钮照常建会话。
- 「计划」首条消息的 `policy` 参数此前三处调用都没传，即使装了 plan 模式也一直走兜底文案。
- `test/dsh-jira-status.mjs` 定位「筛选」按钮时会拿到同一行新加的「按迭代 / 按 epic」切换按钮
  （都是 `jmw-filterbtn`），改按 `aria-label` 认。
- **从属关系视图：epic / 父任务，不靠画布。** 面板原先只有「项目 tab × sprint」一条线；现在每行额外带一行
  `↳ epic APP-123 · 标题`（子任务没有 epic 时显示 `↳ 父任务 APP-123`），点一下跳到那条任务（在当前列表里
  就滚过去并切到「全部项目」，不在就新窗口打开 Jira）。标题栏右侧的 **按迭代 / 按 epic** 开关把同一批数据
  换一条线分组：按 Epic Link 归组，**横跨多个项目的组**在组头标「N 个项目」；两种视图共用同一套虚拟列表、
  折叠状态与计数，切换不重拉、不丢滚动。没挂关联的行不占额外高度；站点没有 epic 字段时静默退到
  「无 epic」一组（不报错、不弹提示）。
  - Host：`resolveEpicField`（按 `schema.custom` 认 `gh-epic-link` / `gh-epic-label`，再按「名字含 epic 且
    类型 any」兜底，实例缓存；`/rest/api/3/field` 失败就当没有）、`epicOf`（兼容 `{key,summary}` / 纯键串 /
    只有 id 三种形状）、`groupByEpic`（组名优先用 epic 摘要，`gh-epic-link` 只给键串时退回键）；
    `buildItemJson` 增 `parentKey` / `parentSummary` / `epicKey` / `epicSummary`（`parent` 保留兼容），
    列表与单条 issue 查询都带上 epic 字段，载荷增 `epics`。
  - **顺带修掉一个真站点的坑**：同一个站点可能同时有 `gh-epic-label`（恒空）和 `gh-epic-link`（带键串），
    字段表里 label 排在前面；按数组顺序 `find` 会选中恒空的那个，epic 视图永远只有「无 epic」一组。
    现在按 schema 的**优先级**找（link 优先），`test/dsh-jira-epic.mjs` 钉死这个顺序。
  - Client：`groupMode` 快照、`buildGroups(data, project, mode)`、折叠键带维度前缀（两种视图的 `none` 组
    不串折叠）、行内关联行、组头项目数徽标、分段控件；字典新增 `groupBySprint` / `groupByEpic` /
    `epicNone` / `epicProjects` / `relParent` / `relEpic` / `relOpen`（zh + en）。
  - 测试：新增 `test/dsh-jira-epic.mjs`（离线 21 项：字段解析优先级、三种字段形状、分组与跨项目计数）；
    `test/dsh-jira-visual.mjs` 新增 L 段（分段控件、关联行、epic 优先、跨项目徽标、两种视图共用数据）；
    `test/dsh-jira-json.mjs` 增 `epics` 载荷形状断言。

- **面板搜索，行为对齐 Jira 自己的搜索框。** 标题右侧新增放大镜：点开后**在原位向左展开**输入框（宽度过渡），
  失焦或 Esc 收回按钮，回车搜 **整站**（不只指派给我的）——
  关键词走 Jira 的 `text ~ "…"`（摘要 / 描述 / 评论），输入 issue key 或粘贴 `/browse/APP-123` 链接则直接
  `key = "…"` 定位。命中结果沿用面板原有的 sprint 分组 / 项目 tab / 状态筛选 / 准确总数，所以每一行都能看到
  它属于哪个迭代；`×` 清空回到「我的工作」。没回车的草稿在收起后保留，执行搜索后输入框清空、结果保留。
  输入框是半透明毛玻璃
  （借用 DSH 菜单的 `--dsw-menu-surface-fill` / `--dsw-menu-backdrop-filter`，深浅色自动适配），
  聚焦时蓝色描边 + 光晕，放大镜画在框内左侧。收起时先缩宽、最后才淡出，输入框常驻到动画结束，
  所以看到的是「缩回按钮」而不是整块瞬间消失。命令面同时支持
  `/jira --search=<文本>`（搜索词可带空格，按 token 一直吃到下一个 `--` 开关）。
- `test/dsh-jira-search.mjs`（离线，21 项断言：全文 / key / browse URL、JQL 转义、`--status` 组合、
  `approximate-count` 的 `AND project = …`、空搜索回落）与 `test/dsh-jira-visual.mjs` 新增 K 段
  （放大镜 → 输入 → 回车 → 按迭代分组 → 清除 / Esc）。
- **README 截图补上这一版的新功能**：`docs/images/` 新增 `panel-search`（面板里搜「结算」/ `checkout`，命中按迭代分组）、
  `panel-epic`（按 epic 分组、跨项目组头）与 `panel-plan`（`☰ 计划` 的已绑定 / 未绑定两种状态），中英各一套；
  `panel` / `panel-watch` 也重出——图上现在带 `↳ epic …` 从属行。出图脚本 `test/dsh-jira-shot.mjs` 走真实交互
  （点放大镜 → 输入 → 回车并断言命令面收到 `--search=`；点「按 epic」并断言三个组头），截图前还会用无头 Chrome
  **按真 CSS 量一遍行高**再重排，组头与带从属关系的行因此落在浏览器里的真实位置。

## [0.15.1] - 2026-11-19

### Fixed

- **四条 `/api` 路由在真宿主里根本没注册 —— 配置页「读取令牌状态失败：HTTP 404」的根因。** 插件在 `apply()`
  里同步 `ctx.get('connection')` 取 Fetch 注册表；而 `client-connection` 的 `apply` 是异步的（先建 BrowserAuth
  的密钥），同一个加载批里它还没 provide，`ctx.get` 只返回 `undefined`，之后也不会有人再补 —— 角标状态 / 状态流转 /
  令牌配置 / 配置写入四条路由就这样静默丢掉（Host 侧只剩三行「这个 profile 没有 connection.fetch 服务」的 note，
  浏览器侧 `GET /api/jira-work-overview/credential` 直接 404）。现在四条路由统一走 `ctx.inject(['connection'], …)`，
  等服务就绪再注册（服务重建时会重跑）；没有 `ctx.inject` 的老宿主 / 离线测试桩仍退回同步读取。
- `test/dsh-jira-credential.mjs` 的宿主桩改成真宿主的时序：加载时 `ctx.get('connection')` 返回 `undefined`，
  只有 `inject` 回调能看到它；回调执行后必须凑满 4 条路由，否则打印 `FAIL` 并以 1 退出。这条回归以前是
  「离线测试全绿、真机路由全 404」。

## [0.15.0] - 2026-11-19

改状态变轻了（不再为一行变化重拉整个列表），也不会再被自己的操作通知一次；面板的失败提示按类型说话。

### Added

- **改状态后不再全量重拉列表。** 面板以前写入成功后直接 `load()`，而 `/jira --json <scope> --limit=0` 会一直翻页把
  几百条 issue 重新拉一遍；现在就地更新那一行（状态徽标、三色状态点），并按与 host 一致的口径重算 `counts`、
  每个 `sprints[].counts`（组头的「未完成 N / 共 M」）、状态筛选菜单（新状态按「分类 → 名字」插入同一套排序）、
  `total` 与 `projectTotals`；状态筛选开着时改到别的状态，该行就地消失、总数减一。只有当前载荷里找不到这个
  key（列表还没加载完 / 已被别处刷掉）才回退到整表刷新。**行不重排**：`all` 范围按 `updated DESC` 排序，
  本地更新拿不到新的 `updated`，这条会留在原位直到下一次整表刷新。
- **自己改的状态不再触发通知。** 写入前后记一份期望（key → from / to / 分类，TTL 24h，写在 POST 之前以堵住轮询
  并发窗口），下一轮后台轮询 diff 命中同一对 from → to 时静默吸收，只推进基线：不弹系统通知、不进未读角标、
  不进「N 项新变化」横幅。面板 POST 额外捎带 `from` / `to` / `category`；`jira_transition`（`apply: true`）
  用自己手上的 `current` 与目标状态走同一条路径。自己把 Done 的 issue 改回未完成（重新出现在「未完成」查询里）
  也不算「新指派」。**对账只认这一对值**：同事把同一个 issue 改成别的状态照常通知；写失败立刻撤销期望。
- `test/dsh-jira-visual.mjs` 新增 J 段：改状态后**没有**新的 `/jira` 命令、行内徽标 / 状态点 / 组头未完成数就地变、
  POST 带上 `from` / `to` / 分类、新状态并入筛选菜单、状态筛选下改到别的状态该行消失且总数减一。
- 新增离线套件 `test/dsh-jira-selfwatch.mjs`：用 fetch 桩驱动后台轮询的 diff——别人改照常通知、面板 / 工具自己改
  静默且基线推进、同事紧接着改成别的状态仍然通知、写失败不留残影、期望表消费干净。
- 测试钩子 `onWatchState`（与 `onNotify` / `onOpenPatch` / `onDetectEditors` 同一套手法，配置卡片里没有这一项）
  和 `watchState.poll()`：离线测试直接推进一轮轮询，不用等真实的 15s+ 间隔。
- **可分类的失败 + 对应的提示文案。** `--json`（面板专用）失败时 host 不再抛错，改为回一份形状正常的载荷带 `ok:false` 与 `error.code`：`no_credential` / `credential_unreadable` / `no_email` / `no_base_url` / `auth`（HTTP 401/403）/ `network` / `http` / `not_json` / `unknown`。面板按 code 显示标题 + 一句「怎么办」，`去配置` 直达令牌弹窗、`重试` 重新查询；只有 `auth` / `network` / `http` / `not_json` 这类需要看原文的，才把原始 message 以小字附在提示下面。类型是 host 给的稳定 code，不靠匹配报错文案（`CommandResult` 只有 `{kind,text}` 两个槽）。
- 凭据库读不出来与「压根没配」分成两种（`credential_unreadable` / `no_credential`）：前者说明三条来源都没有值、且凭据服务本身报错，提示是「重新保存一次令牌」而不是「去配置」。
- 后台监视的失败也带类型（`watch.lastErrorCode`）：凭据没了这类原因在页脚显示同一句提示，而不是原始报错。
- `test/dsh-jira-visual.mjs` 新增 I 段：无令牌 → 提示 + 「去配置」打开弹窗且原始报错不可见；401 → 标题 + 详情小字；恢复后点「重试」回到正常列表。
- `test/dsh-jira-json.mjs` 在 `--json` 失败时打印 `SKIP:` 并以 0 退出（以前会 JSON.parse 崩掉）。

### Changed

- 文本模式的 `/jira`（人在命令面里敲）行为没变：失败仍返回 `kind:'error'` 的原始报错 —— 命令面本来就该看到真实原因。

## [0.14.0] - 2026-11-19

高亮不再写死「`Highest` 就是最高级」，改为挂到 Jira 自己给的优先级名次上。

本版同时**首次发布到 npm**（公开包）：`plugin_manager install_bundle(target="dsh-jira-work-overview")`（也可以 `npm i dsh-jira-work-overview`）。三种安装方式（npm / GitHub 直装 / 本地路径）见 README。

### Added

- **面板高亮按 Jira 的优先级名次，而不是按名字。** 名次取自 `GET /rest/api/3/priority` 返回数组的**下标**（0 = 站点里的最高级）：名次 0 红底 / 名次 1 琥珀底 / 其余不上色（徽标照旧）。于是站点调换优先级顺序、或者用 `P0` / `Blocker` 这类自定义名字也照样正确。拿不到名次（旧载荷 / 站点没暴露这个接口）时退回原来的名字匹配（`Highest` / `High`），行为不变。
- `--json` 的每个 item 新增 `priorityId`（Jira 的优先级 id，字符串）与 `priorityRank`（上面的名次，拿不到时 `null`）；单条 issue 的 `--json` 同样带上。文本输出不受影响。
- `test/dsh-jira-visual.mjs` 新增 H 段：自定义名字（`Blocker` / `P0` / …）仍按名次上色、徽标配色只看名次、剥掉 `priorityRank` 时名字兜底仍生效。
- `test/dsh-jira-i18n.mjs` 的 fetch 桩加了优先级清单，断言名次来自站点顺序、`priorityId` 原样带出。

### Changed

- 优先级清单**不带任何参数**地取一次就够：结果缓存 6 小时；失败（例如令牌没有权限）短退避 5 分钟，其间不再重试。**这个能力是可选的** —— 清单拿不到只是不上色，列表查询本身照常成功。
- 没用 `priorityscheme` 系列接口：`GET /rest/api/3/priorityscheme/{id}` 实测返回 `405 Method 'GET' is not supported`，列表接口对普通用户回空表（要 Administer Jira 权限），所以「按 scheme 排序」这条路对普通令牌不可得；`GET /rest/api/3/priority` 只需要 "Permission to access Jira"，且实测其顺序与 JQL `ORDER BY priority ASC/DESC` 的结果一致。

## [0.13.4] - 2026-11-19

去标识化版本：仓库转为公开之前，把属于作者本人 Jira 的值从代码、文档与 git 历史里全部拿掉。

### Changed

- **示例项目键统一成虚构的 `APP`**：README / 代码注释 / 工具说明 / 测试 fixture 里原先写着作者自己的项目键和几条真实 issue key，现在一律是虚构的 `APP-####`（截图生成器里原有的 `APP` / `OPS` 工单保持原样）。
- **`projectKey` 的默认值改成 `''`**（原先硬编码成作者的项目键）。它只用于展示；`boardId` 本来就没有默认值。两者都填在你自己的 profile patch 里（README 的配置示例是虚构的 `APP` / `42`）。
- **测试脚本不再硬编码本机 checkout 路径**：6 个真实站点套件原先写着作者机器上的绝对路径，现在从脚本自身位置推导（`dirname(dirname(fileURLToPath(import.meta.url)))`），换机器 / 换目录都能跑。
- **真实站点套件的项目键与看板 id 改由环境提供**：优先 `DSH_JIRA_PROJECT` / `DSH_JIRA_BOARD`，其次读 env 文件里的 `JIRA_PROJECT` / `JIRA_BOARD`，都没有时才用虚构的 `APP` / `42`；离线套件用固定假值。

### Security

- 文档里的令牌掩码示例（首尾各 4 位那串）换成纯假值 `ATAT…0000`；fixture token 的尾部也不再复用真实 token 的最后 4 位。
- git 历史整体重写（所有提交与 4 个 tag 一起重指），把同样的值从历史提交的内容里拿掉；`v0.13.3` 及更早的 Release 仍按 tag 名解析到脱敏后的提交。

## [0.13.3] - 2026-11-19

### Fixed

- **「折叠全部」后组头的标题与日期错位。** `@tanstack/react-virtual` 的默认 `getItemKey` 是 `index => index`（库里的 `defaultKeyExtractor`），实测行高按**下标**缓存。折叠 / 展开会让同一串下标换成完全不同的条目：折叠前下标 1 是任务行（约 32px），折叠后下标 1 变成第二个组头（约 64px），复用旧高度就把两个组头压在一起 —— 上一个组头底部的「迭代区间」（日期）和下一个组头的标题叠住了。现在 `getItemKey` 按条目身份取（`g:<组 id>` / `i:<issue key>`），折叠前后同一个组头命中它自己那份实测高度（元素缓存 `elementsCache` 同理）。
- 虚拟列表的 `estimateSize` 改成按条目类型估（组头 64px / 任务行 32px）：此前一律按 32px 估，滚动中每量到一个组头整列就往下窜一截，`scrollHeight` 与滚动条滑块跟着跳。
- **滚动列表时 macOS 整屏闪一下。** 面板与令牌弹窗的整屏遮罩（`.jmw-mask`、`.jmw-credmask`）用了 `backdrop-filter:blur(2px)`：整窗大小的 backdrop-filter 在 macOS + Electron 上会在滚动重绘时让整屏闪一下。遮罩现在只压暗（`--dsw-alias-bg-mask-1`）不再模糊 —— 2px 高斯加在 24% 黑上本来就几乎看不出来，去掉没有观感损失却拿掉了整窗合成层。

### Added

- `test/dsh-jira-visual.mjs` 新增 G 段（`PASS`/`FAIL` + 退出码）：钉死「条目 key 跟着身份走」「折叠前后同一个 key 能复用高度」「estimateSize 按类型分开」「两处遮罩里没有 backdrop-filter 声明」。
- README 的产品截图（`docs/images/{panel,panel-watch,sidebar-entry}{,.zh}.png`，浅色主题、中英各一套），插在 README.md / README.zh.md 的开头、安装（左侧栏入口）和面板小节里。图是**离线生成**的：真 `client.js` 组件 + 真插件 CSS + 一套**虚构**的 APP/OPS 工单，序列化成静态 HTML 后用无头 Chrome 截图 —— 所以图里不会出现真实站点、账号或 issue 摘要。
- `test/dsh-jira-shot.mjs`：上面那套图的生成器（离线，不联网；`--lang en,zh` / `--theme light|dark` / `--only …` / `--out <目录>`，找不到 Chrome 时打印 `SKIP:` 并以 0 退出）。
- `package.json` 的 `files` 加上 `docs`，让 npm 包里的 README 也能显示这些图片。

## [0.13.2] - 2026-11-19

### Fixed

- **The client half never loaded after the 0.13.0 rename.** `client.js` still registered its bundle as `@local/dsh-jira-work-overview` while the package — and therefore the host's client-module row — is `dsh-jira-work-overview`. The host composes the boot graph by package name and only reports `client-modules: bundle <url> loaded without registering "<package>" via __ModuleLoader__.load`, so the whole browser half stayed dark: the left-sidebar entry, the overlay panel and all three config pages disappeared while `plugin_manager` kept showing `fiberPhase: "active"`. The registered id now equals `package.json.name`.
- `README.zh.md` still called the package `@local/dsh-jira-work-overview` in its title and in the two `plugins.bundle.config` / `plugins.row.config` key examples.

### Added

- `test/dsh-jira-bundle-id.mjs`: offline regression suite that pins `window.__ModuleLoader__.load({ id })` and `cordis.patch.yml`'s `insert[].name` to `package.json.name`, and rejects any `@local/` leftover in `client.js` / `cordis.patch.yml` / `package.json`.

## [0.13.1] - 2026-11-19

### Removed

- The three stale test suites (`test/dsh-jira-client.mjs`, `test/dsh-jira-client2.mjs`, `test/dsh-jira-watch.mjs`): they predated the 0.7 panel redesign, had failed ever since, and are covered by `test/dsh-jira-visual.mjs` + `test/dsh-jira-credential.mjs`.

## [0.13.0] - 2026-11-19

### Added
- `LICENSE` (MIT), `CHANGELOG.md`, `.gitignore`, and an English-first `README.md` (the previous Chinese README is kept as `README.zh.md`).
- `err.noBaseUrl`: a clear message when the Jira site URL has not been configured yet.
- `CHANGELOG.md` is included in the published `files`.

### Changed
- Package renamed `@local/dsh-jira-work-overview` → **`dsh-jira-work-overview`** so it can be installed from npm/git by anyone; `private: true` removed, `license` / `author` / `keywords` added.
- `cordis.patch.yml` now ships **neutral defaults only** — no Jira site, email, project key or board id (they belong to each user's profile and are set in the panel).
- `DEFAULTS.baseUrl` and `DEFAULTS.projectKey` are empty instead of the author's values; `jira.site()` was added so the site URL is always read from live settings.

## [0.12.0] - 2026-11-19

### Added
- Virtualized issue list using `@tanstack/react-virtual` (it is part of DSH's base module table, so no bundling is needed): only the visible rows live in the DOM, the container is sized with `getTotalSize()`, and row heights are re-measured by `measureElement`. Falls back to full rendering with a single `console.warn` when the module is unavailable.
- `maxResults: 0` = **unlimited** (now the default): the host pages until there is no next page.
- A safety net for unbounded fetches: 5000 items / 50 pages / one `timeoutMs` budget, with `AbortSignal.any()` merging the caller signal and the timeout. Partial results are returned **honestly** with `hasMore: true`.
- Footer states "loaded N (all)" / "safety cap 5000 reached, more available" / "cap M".

### Removed
- The progressive rendering of 0.11.0 (`renderCount`, `RENDER_FIRST`, `RENDER_STEP`, the "rendering N / M rows" line).

## [0.11.0] - 2026-11-18

### Added
- Header shows the **accurate total** for the current project + status filter, taken from Jira's `approximate-count` endpoint (verified against full pagination: 9 = 9, 332 = 332).
- Single-select **status filter** in the toolbar (default: all statuses), applied server-side through `--status=<name>` so list and counts can never disagree.
- `--status` on the slash command and tool parameter, with `AND status = "X"` inserted **before** `ORDER BY` (concatenating after it makes Jira return HTTP 400).

### Changed
- The panel always queries "all my issues"; the unused scope segment control was removed. The slash command still defaults to `open`, and background watch is unchanged.
- Item cap raised to 500 / 1000 with progressive rendering (later replaced by 0.12.0's virtualization).

## [0.10.0] - 2026-11-18

### Added
- **Editor picker** for "open `cordis.patch.yml`": the host detects editors that actually exist on the machine (`EDITOR_CANDIDATES`, `where` on Windows, PATH lookup on Linux) and renders only those, remembers the last one (`preferredEditor`), and also accepts a free-form application name or path (passed as a single argv, no shell).
- Accurate totals: `total` and `projectTotals` in the JSON payload (project tabs no longer show a number; the total moved next to the scope control).

### Fixed
- JQL conditions are now inserted before `ORDER BY` (`withJqlClause`), which previously produced invalid JQL and silently empty `projectTotals`.

## [0.9.0] - 2026-11-18

### Added
- **Internationalization**: the host keeps a `TEXT = { zh, en }` dictionary (146 keys) and resolves the language from `DSH_JIRA_LANG` → per-call override (`--lang=` / `?lang=`) → `language` config → the host `locale.preference` → the language the panel reported → system env → ICU → `en`.
- Configure dialog: **UI language chips** (auto / 中文 / English) and the **"open `cordis.patch.yml`"** section (default app, system app chooser, file-manager reveal), exposed through `POST /api/jira-work-overview/settings {open: …}` and `patch` info on `GET`.
- Client half follows `locale/change` and reports its language on every request, so tool output matches the panel.

### Changed
- Plugin display name → **Jira work overview**; panel fixed to the DSH language setting; Jira data is never translated.

## [0.8.10] - 2026-11-18

### Added
- **Windows/Linux support**: notifications dispatch per platform (osascript / PowerShell Toast with `-EncodedCommand` / `notify-send`), all failures silent; toast text truncated to 200 characters.
- Font fallbacks for Windows (`Segoe UI`, `Microsoft YaHei`, `Consolas`, `Cascadia Mono`).
- Test scripts no longer hardcode `/tmp` (`DSH_JIRA_TMP`, `os.tmpdir()`), and README gained a platform-support section.

### Changed
- The project strip's scrollbar is visible (5 px) because Windows has no overlay scrollbars.

## [0.8.9] - 2026-11-18

### Added
- Configurable fetch size (`maxResults`, runtime-editable) and a **"load more"** button (appears only when the host truncated the result).
- `--limit=<n>` on the slash command; `MAX_PAGES` raised and the "there is more" line added to text output.

### Fixed
- Documented and answered that the query is **one global JQL** — the limit is a cross-project, cross-sprint total, not a per-sprint count.

## [0.8.8] - 2026-11-18

### Fixed
- Tool header and Basic-auth header now read the email through `liveSetting()` instead of the startup snapshot, so editing the email takes effect immediately.

## [0.8.7] - 2026-11-18

### Added
- The login **email is editable** in the configure dialog (token and email are a pair); "Save & verify" checks the combination against `/rest/api/3/myself` and refuses to store a rejected pair.
- `resolveToken()` reports where the credential came from; `writeSettings()` can persist the email.

## [0.8.6] - 2026-11-18

### Added
- **Project tabs** with scroll buttons, so several Jira projects can be viewed in one panel; grouping is recomputed per project.
- The configure dialog no longer shows the (read-only) project name and board id.

### Fixed
- Test predicate `className.startsWith('jmw-row')` also matched `jmw-rowmeta`.

## [0.8.5] - 2026-11-18

### Changed
- Everything except the token applies **as you change it**: watch switch, interval (700 ms debounce, immediate on blur/Enter), notifications and language write straight to the profile patch. Only the token keeps an explicit "save" button.

## [0.8.4] - 2026-11-18

### Fixed
- The configure dialog is a real centred modal again (a previous CSS rewrite had deleted `.jmw-credmask` / `.jmw-credmodal` / `.jmw-btn.ghost`).
- Button colours are hardcoded (`#4d6bfe` / `#d64545`) because `--dsw-alias-brand-primary` resolves to near-white in the dark theme — white text on a white button.
- Closing the panel closes every overlay: the configure dialog's open state moved into the shared snapshot (`closeAll()`), so reopening the panel shows only the list.

## [0.8.3] - 2026-11-18

### Added
- Grouped configure page ("title + content" per feature), a configurable watch interval, inline button colours, and a **settings write route** (`/api/jira-work-overview/settings`) that persists `watchEnabled` / `watchIntervalMs` / `notify` through the host `settings` service into the profile's `cordis.patch.yml`.
- The watch loop became self-scheduling (`setTimeout` re-read on every tick) and listens for `loader/volatile-update`, so changes apply without a restart.

## [0.8.2] - 2026-11-18

### Changed
- Token settings moved into their own modal, opened from a **Configure** button at the right of the panel title (Esc closes the modal first, then the panel).

## [0.8.1] - 2026-11-18

### Added
- Two more ways to reach the settings: a bundle-level config section on the plugin detail page (`plugins.bundle.config`) and a panel entry, because the row-level `plugins.row.config` entry is only "the row title is clickable" — no visible "Configure" label.

## [0.8.0] - 2026-11-18

### Added
- **API token editing** in the plugin's own config page: masked current value (`ATAT…0000`), password input, verification against `/rest/api/3/myself`, 401/403 refusal (nothing is stored), two-step clear, and a read-only list of the effective settings. Token stays in the DSH credential store.

### Changed
- Plugin renamed from "Jira my sprint" to **Jira work overview** (package, routes, slot ids, CSS markers, i18n descriptions).

## [0.7.3] - 2026-11-18

### Added
- Switching scope/status **aborts the previous request** (AbortSignal plus a sequence number that discards stale responses) and dims the old list while the new one loads.

## [0.7.2] - 2026-11-18

### Changed
- Removed the "current sprint" entry: the open view is already grouped per sprint.

## [0.7.1] - 2026-11-18

### Removed
- The "active sprint" line in tool output (the board's sprint states do not match reality).

## [0.7.0] - 2026-11-18

### Added
- High/Highest issues are highlighted with a row background, stronger colour for Highest.

### Removed
- The "in progress" chip and per-sprint "ended N days ago" text — the board's sprint state is not a reliable work-progress signal.

## [0.6.0] - 2026-11-18

### Added
- **Status changes from the panel**: per-row status dropdown listing the issue's real workflow transitions (fetched live), applied through `POST /rest/api/3/issue/{key}/transitions` and re-read afterwards (the API returns 204).
- The `jira_transition` tool (preview by default) and a `transition` fetch route.

## [0.5.0] - 2026-11-18

### Added
- **Live watch**: the host polls "assigned to me and not done", diffs it (new / status change / left the list), sends desktop notifications and exposes a long-polling fetch route (`/api/jira-work-overview/state`) that feeds a sidebar unread badge and a "what changed" banner with mark-as-read.
- Panel auto-refreshes when a change arrives.

## [0.4.0] - 2026-11-18

### Added
- Issues grouped by **sprint** (newest sprint first), collapsible groups (fully-done groups start collapsed), a unified card style, and the sprint field resolved by `schema.custom` (`com.pyxis.greenhopper.jira:gh-sprint`) instead of the localised name.

## [0.3.0] - 2026-11-18

### Added
- **Client panel**: a "Jira work overview" entry at the bottom of the left sidebar opens a modal with the work-item list; data comes from the host through `ctx.remote.commands.execute('/jira --json')`.
- Returns explicitly refused to use a build-time Host remote BFF, so the command is the shared implementation for humans and the agent.

## [0.2.0] - 2026-11-18

### Added
- `/jira` slash command rendering in the command surface (no model message, no tokens), argument parsing for scope / issue key / raw JQL, and a clearer network error carrying the error cause.

## [0.1.0] - 2026-11-18

### Added
- First working bundle: `jira_my_work` and `jira_issue` tools backed by `/rest/api/3/search/jql`, grouped Markdown output with a status distribution, the `Config` card, and the token read from the DSH credential store (`ctx.get('credentials')` → env → config), with a migration note when a plaintext token is present.
