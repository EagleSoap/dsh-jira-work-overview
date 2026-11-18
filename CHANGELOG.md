# Changelog

All notable changes to **dsh-jira-work-overview** are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html). The first 25 releases were built in a single day, so the dates are real but the cadence was not: each entry lists what changed, not how long it took.

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
