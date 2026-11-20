# dsh-jira-work-overview

Show **your** Jira work items — with their real workflow status — inside [DeepSeek Harness](https://github.com/deepseek-ai) (DSH): as agent tools, as a `/jira` slash command, and as a panel in the left sidebar with a live unread badge.

> 中文说明见 [README.zh.md](README.zh.md) · Changelog: [CHANGELOG.md](CHANGELOG.md) · License: [MIT](LICENSE)

<p align="center">
  <img src="docs/images/panel.png" width="1040" alt="The Jira panel inside DSH: rows grouped by sprint, with status chips, High/Highest highlights, project tabs and a single-select status filter">
</p>

---

## What you get

- **Rows are highlighted by Jira's own priority order** — the top two levels get a row background and a left bar (reddest = highest), read from `GET /rest/api/3/priority` rather than a hard-coded "Highest", so a site that reorders priorities or uses custom names (`P0`, `Blocker`) still gets it right. Everything below stays uncoloured. If the site does not expose that list, the panel falls back to matching the names `Highest` / `High`.
- **Left-sidebar panel** — one row per issue, grouped by sprint (collapsible, newest sprint first), with project tabs, a single-select **status filter**, an **accurate total** in the header, priority highlighting (see above), and a status dropdown to move an issue through its workflow **in place** — only that row and the counts are updated, the list is not re-fetched.
- **Epic / parent relations, without a canvas** — every row carries its place in Jira's own hierarchy: a `↳ epic APP-123 · <title>` line (or `↳ parent APP-123` for sub-tasks without an epic), clickable to jump to that issue. A **按迭代 / 按 epic** switch in the header re-groups the same list by Epic Link instead of sprint, and a group that spans several projects is labelled with its project count — so "which epic is this across projects" is one glance, with no free-form graph to maintain. Both views share the same virtualization, collapse state and totals; a site without an epic field silently falls back to the "no epic" group, and rows without any relation take no extra height.
- **Search, Jira-style** — the magnifier in the panel header opens a search row. Enter searches **all of Jira** (summary / description / comments, via Jira's own `text ~` operator), not just your issues; an issue key or a pasted `/browse/APP-123` link jumps straight to that issue. Results reuse the same sprint grouping, project tabs, status filter and accurate total, so a hit shows which sprint it belongs to; `×` clears back to your work.
- **Live watch** — the host polls "assigned to me and not done" in the background; new assignments / status changes show a **system notification**, an **unread badge** on the sidebar entry, and a "what changed" banner with *mark as read*. The panel refreshes itself when a change arrives.
- **Three agent tools** — `jira_my_work`, `jira_issue`, `jira_transition` (preview by default, writes only with `apply: true`).
- **One slash command** — `/jira [--json] [--limit=<n>|0] [--lang=<tag>] [--search=<text>] [open|sprint|all | <issue key> | <JQL>]`; it renders in the command surface, so it costs no model tokens.
- **Configure dialog** — Jira site / email / API token (token goes to the DSH credential store), fetch size, watch switch + interval, notification switch, UI language, and one-click **open `cordis.patch.yml`** (default app / system "open with" chooser / detected editors / custom app).
- **Bilingual UI** — follows the DSH language setting (`设置 → 通用 → 语言`), live; Jira-returned text (summaries, status names, labels) is always shown verbatim.

## Requirements

| | |
| --- | --- |
| DSH | Desktop app or `dsh web`, with the plugin manager (`plugin_manager`) available |
| Jira | Cloud or Server, plus an **API token** for your own account and your login email |
| Build step | none — the package ships `index.js` (host half) and `client.js` (web half) as-is |

## Install

DSH installs plugins from an **installation spec** — anything `pnpm add` accepts (registry package name, git URL, tarball, absolute path). Pick one:

```bash
# 1) from the npm registry (published since 0.14.0; pin a version with @0.15.1)
plugin_manager install_bundle(target="dsh-jira-work-overview")

# 2) straight from GitHub (no npm publishing needed)
plugin_manager install_bundle(target="github:EagleSoap/dsh-jira-work-overview")

# 3) from a local checkout
plugin_manager install_bundle(target="/absolute/path/to/dsh-jira-work-overview")
```

Or do it in the UI: left icon rail → **Plugins** → install, and paste the same spec.

Installing adds `dsh-jira-work-overview` to your profile's bundle list and inserts the plugin row declared in `cordis.patch.yml`. The host then serves the web half as a plugin bundle — **refresh the page** (Cmd/Ctrl+R) and the sidebar entry appears.

<img src="docs/images/sidebar-entry.png" width="248" alt="The 'My Jira work items' entry above Settings in the left sidebar, showing an unread badge">

## First-run configuration

The bundled `cordis.patch.yml` deliberately contains **no site-specific values**, so nothing of the author's Jira account is shipped. Open the panel, click **配置 / Configure** in the panel header, and fill in:

| Field | Example | Required |
| --- | --- | --- |
| Jira site URL (`baseUrl`) | `https://your-site.atlassian.net` | ✅ — the tools tell you when it is missing |
| Login email (`email`) | `you@example.com` | ✅ (Basic auth = email + token) |
| API token | create one at [id.atlassian.com → API tokens](https://id.atlassian.com/manage-profile/security/api-tokens) | ✅ |
| Project key / board id | `APP` / `42` | optional, used for labels and the sprint field |
| Fetch size (`maxResults`) | `0` = unlimited | optional |
| Watch switch / interval, notifications, UI language | — | optional (change = save) |

The token is written to the **DSH credential store** (key `JIRA_API_TOKEN` unless you change `credentialKey`); it never enters the repo, the logs, or the UI (the panel only shows a masked form such as `ATAT…0000`). Before storing, the plugin verifies the email + token pair against `/rest/api/3/myself` and refuses to save a rejected token.

Prefer files? Add an override row to your profile's `cordis.patch.yml` (this is also where the panel writes the ✏️ fields):

```yaml
- id: jira-work-overview
  config:
    baseUrl: https://your-site.atlassian.net
    email: you@example.com
    projectKey: YOURKEY
    boardId: 42
```

## Usage

### Panel

- **Project tabs** (with `‹ ›` scrolling) filter by issue-key prefix; **status filter** is single-select, defaults to "all statuses".
- **Search**: the header magnifier expands in place into a field that slides out to the left; type a keyword or an issue key and press **Enter**. The query runs against all of Jira (not only your issues); matches are grouped by sprint like your own list, with the same project tabs / status filter / total. Losing focus (or **Esc**) collapses the field back to the button and keeps an unsubmitted draft; a submitted query clears the field and keeps the results, and `×` clears the search to return to your work.
- The header shows the **accurate total** for the current project + status, straight from Jira's `approximate-count`.
- Click a **status chip** on any row to move the issue; the list reloads. **Esc** closes the top-most layer (status menu → configure dialog → panel).
- The list is **virtualized**: thousands of rows scroll smoothly because only the visible ones are in the DOM.
- **Plan at the end of a row** (the `☰ 计划` chip) opens a *planning* conversation for that issue in the
  workspace the project is linked to: the new session switches to plan mode, receives the issue key, title, status and link, and is told
  to report **only the list of changes it intends to make** — no explanations, no analysis. You approve or amend
  the plan in that conversation, and nothing is executed before you do. If the issue is too thin to plan (no
  description, no parent and no links), the session stops instead of guessing and tells you the Jira issue is
  unclear. One issue maps to one planning session: once bound the chip is highlighted, clicking it reopens the
  existing conversation (the binding lives in the volatile `planSessions` config as `ISSUE<TAB>sessionId`, and a
  lost binding is recovered from the `JIRA_PLAN_SESSION:<KEY>` marker in the session's first message). The button
  reports what is missing when the project has no linked workspace; if the profile ships
  `deepseek-ai/dsh-plan-mode`, its `section` is the planning policy, and without it the first message carries a
  built-in one ("plan only, list the changes, execute once the user agrees").

<img src="docs/images/panel-watch.png" width="1040" alt="The live-change banner and a row with its status dropdown open (To Do / In Progress / IN QA / Done)">

### Slash command

```
/jira                       # my open items, text
/jira --json                # same, as JSON (used by the panel)
/jira --limit=200           # cap this call (0 = unlimited)
/jira --status="IN QA"      # server-side status filter
/jira --search="login error" # full-text search across all of Jira (or an issue key)
/jira APP-4051              # one issue in full
/jira project = APP AND duedate is not EMPTY
```

### Agent tools

| Tool | Purpose |
| --- | --- |
| `jira_my_work` | my issues + status, grouped; `scope` = `open` / `sprint` / `all`, or your own `jql`; `status` filter; `limit` |
| `jira_issue` | one issue in full: fields, description (ADF → plain text), optional recent comments |
| `jira_transition` | list the workflow transitions of an issue, or apply one (`apply: true`) — preview by default |

### Live watch and notifications

The host polls `assignee = currentUser() AND statusCategory != Done` every `watchIntervalMs` (default 60 s, minimum 15 s). New assignments and status changes notify; items that simply leave the open list are recorded but stay silent. The first poll only establishes a baseline.

A status **you** changed — from the panel dropdown or `jira_transition` — is not news: the write records the expected `from → to` and the next poll silently advances its baseline instead of raising a notification, an unread badge or a banner entry. The match is on that exact pair, so a colleague changing the same issue to something else still notifies. Notifications use `osascript` on macOS, a PowerShell Toast on Windows, and `notify-send` elsewhere — silently degrading if the platform refuses.

## Configuration reference

| Key | Default | Meaning |
| --- | --- | --- |
| `baseUrl` | `''` | Jira site root, e.g. `https://your-site.atlassian.net` (**required**) |
| `email` ✏️ | `''` | login email used for Basic auth |
| `apiToken` | `''` | fallback only — prefer the DSH credential store |
| `credentialKey` | `JIRA_API_TOKEN` | credential-store key that holds the token |
| `projectKey` | `''` | optional project label |
| `boardId` | — | agile board id, used to read the active sprint |
| `maxResults` ✏️ | `0` | fetch cap: `0` = unlimited, otherwise 10–5000 (safety net: 5000 items / 50 pages / one `timeoutMs` budget) |
| `timeoutMs` | `30000` | HTTP timeout, and the total budget for one paged fetch |
| `watchEnabled` ✏️ | `true` | background watch on/off |
| `watchIntervalMs` ✏️ | `60000` | watch interval (≥ 15000) |
| `notify` ✏️ | `true` | desktop notifications on changes |
| `language` ✏️ | `auto` | UI/tool language: `auto` / `zh` / `en` |
| `preferredEditor` ✏️ | `''` | last editor used for "open `cordis.patch.yml`" |

✏️ = runtime-editable: the panel writes it through the host `settings` service into the **active profile's `cordis.patch.yml`**, and it applies immediately (no restart).

## Platform support

| | macOS | Windows | Linux |
| --- | --- | --- | --- |
| Notifications | `osascript` | PowerShell Toast (`-EncodedCommand`) | `notify-send` |
| Open `cordis.patch.yml` | `open` / `open -R` / osascript app chooser | `cmd /c start` / `rundll32 … OpenAs_RunDLL` / `explorer /select,` | `xdg-open` |
| Host paths | POSIX | avoid spaces in the install path — DSH records it as a `link:` dependency | POSIX |

The web half only uses standard React/DOM APIs (`color-mix`, `createPortal` are supported on all three).

## Internationalization

The plugin's own copy follows the DSH language setting; English and Chinese ship with the plugin and every other language falls back to English. Resolution order: `DSH_JIRA_LANG` → per-call override (`--lang=` / `?lang=`) → `language` config → the host `locale.preference` → the panel-reported language → system env → ICU → `en`. Jira data is never translated.

## Troubleshooting

| Symptom | Meaning |
| --- | --- |
| `Cannot reach https://… (…): ECONNRESET` / `HTTP 000` | your machine cannot reach Jira right now (VPN/proxy/network), not a plugin bug |
| "No matching work items" with no error row | the query returned nothing — widen the status filter or the project tab |
| footer says "live watch unavailable" | the Electron shell did not expose a fetch transport; the panel/badge degrade, tools still work |
| configure dialog says "Reading the token state failed: HTTP 404" | the plugin's `/api` routes were not registered (the host loaded the plugin before its connection service existed) — reload the plugin; a fixed build registers them once the service is up |
| footer says "live watch disconnected" | transient transport error; it retries with backoff |
| token rejected when saving | the email + token pair is wrong, or the token has no Jira access |
| panel says "No Jira token yet" | nothing is configured yet: click **Configure** and paste an API token (or set `JIRA_API_TOKEN`) |
| panel says "Jira rejected this email / token pair" | 401/403 from Jira: regenerate the token; the raw response is under the hint |
| panel says "Could not read the stored token" | the credential store returned an error rather than a value: save the token again from **Configure** |

Behind a corporate proxy on Windows, DSH needs the proxy env vars it was started with (`NODE_USE_ENV_PROXY=1`) — the plugin itself never talks to the network outside `fetch`.

## Security and privacy

- The API token lives in the **DSH credential store**; the plugin only ever returns a masked form + its source, never the value. There is no place in the code where a full token is logged or rendered.
- The plugin reads **only issues assigned to you** (the JQL always starts from `assignee = currentUser()`) and writes **only** the workflow transition you click, plus your own settings.
- Your Jira site / email are personal configuration: they belong in your profile (`cordis.patch.yml` / the panel), **not** in this repository.

## Development

```
dsh-jira-work-overview/
├── index.js          host half: tools, /jira command, fetch routes, watch loop, Jira client
├── client.js         web half: sidebar entry, panel, configure dialog (plain React via __ModuleLoader__)
├── cordis.patch.yml  the plugin row this bundle inserts (neutral defaults only)
├── locale/{zh,en}.json  plugin-list title/description (file name = language id, en.json required)
├── icon.svg          plugin-list icon (36×36, transparent, theme-friendly strokes)
├── docs/images/      README screenshots, rendered by `test/dsh-jira-shot.mjs`
└── test/             offline + real-Jira suites
```

Tests run under DSH's own Electron-as-Node binary (`ELECTRON_RUN_AS_NODE=1`):

```bash
BIN="/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness"
ELECTRON_RUN_AS_NODE=1 "$BIN" test/dsh-jira-visual.mjs      # offline: rendering, virtualization, filters
ELECTRON_RUN_AS_NODE=1 "$BIN" test/dsh-jira-credential.mjs  # offline: config panel, routes, paging
ELECTRON_RUN_AS_NODE=1 "$BIN" test/dsh-jira-i18n.mjs        # offline: language matrix + dict parity
ELECTRON_RUN_AS_NODE=1 "$BIN" test/dsh-jira-transition.mjs  # real Jira (read-only + failure paths)
ELECTRON_RUN_AS_NODE=1 "$BIN" test/dsh-jira-status.mjs      # real Jira (skips itself when unreachable)
ELECTRON_RUN_AS_NODE=1 "$BIN" test/dsh-jira-shot.mjs        # regenerate docs/images (headless Chrome, fake data)
```

The screenshots are generated offline too: `test/dsh-jira-shot.mjs` renders the real `client.js` components with the real plugin CSS and a fixed set of **made-up** APP/OPS issues, serializes them to static HTML and lets headless Chrome shoot them — so the images never contain a real site, account or issue. Run it with `--lang en,zh`, `--theme dark`, `--only panel|panel-watch|sidebar-entry` or `--out <dir>`; it prints `SKIP:` and exits 0 when no Chrome is installed.

The host half imports `@deepseek-ai/schemastery`, which only resolves inside the app, so the suites copy `index.js` next to a copy of that dependency in a temp dir (`DSH_JIRA_TMP` overrides the location). Real-Jira suites read a token from `DSH_JIRA_ENV_FILE` (default `$TMP/.dsh_jira_env`, `chmod 600`) and **skip** when Jira is unreachable instead of reporting a false regression.

## License

[MIT](LICENSE) © 2026 Zhaohong Fei
