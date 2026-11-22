# Tests

All suites are plain Node scripts (`node:assert`-style checks, no test framework) and must run under DSH's own binary with `ELECTRON_RUN_AS_NODE=1`, because the host half imports `@deepseek-ai/schemastery`, which only resolves inside the app.

```bash
BIN="/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness"
ELECTRON_RUN_AS_NODE=1 "$BIN" test/<script>.mjs
```

## Run them all

```bash
node test/run-offline.mjs          # 全部离线套件（CI 用的就是这个）
node test/run-offline.mjs --release  # 同上 + 发版预检进入 release 模式
```

## CI — and running the suites on a machine without DSH

`.github/workflows/test.yml` runs on every push / PR (and on demand) on `ubuntu-latest`, `macos-latest`
and `windows-latest`. GitHub Actions is free for public repositories, so this repo's CI costs nothing.

The suites only need two host packages (`@deepseek-ai/schemastery` + `cosmokit`); DSH itself is not
required. When there is no DSH install, the workflow installs those two packages from npm and hands the
helper a **fabricated** `DSH_INSTALL_DIR` pointing at `<stage>/node_modules/@deepseek-ai/dsh`, which is the
anchor `prepareHostCopy()` expects. Reproduce it locally without DSH:

```bash
STAGE=/tmp/host-deps && mkdir -p "$STAGE" && cd "$STAGE" && npm init -y >/dev/null
npm i --no-audit --no-fund @deepseek-ai/schemastery@3.19.0 cosmokit@1.8.1
mkdir -p node_modules/@deepseek-ai/dsh && cp -R node_modules/cosmokit node_modules/@deepseek-ai/cosmokit
DSH_INSTALL_DIR="$STAGE/node_modules/@deepseek-ai/dsh" node test/dsh-jira-platform.mjs
```

Two workflows:

- `test.yml` — the matrix above, runs `node test/run-offline.mjs`.
- `release-check.yml` — read-only preflight on PR / push / tags (`--release` on tags) plus a dry-run `npm pack` listing. `publish.yml` runs the same preflight (`node test/dsh-jira-release.mjs --release`) immediately before `npm publish`, so a version that disagrees with `CHANGELOG.md`, an un-folded `[Unreleased]`, a mismatched bundle id or a leaked personal value blocks the release instead of shipping.

What CI can and cannot tell you: it really spawns processes on each OS, so path separators, `where`,
argument quoting, exit codes and the SKIP-not-fail rule are exercised for real (the `platform` suite itself
is skipped on the Windows runner because its fake executables are `sh` scripts). It cannot verify a
desktop session: no Toast is shown, no `explorer /select` selection is visible, and the real-site suites
skip without `JIRA_*` credentials (no secrets are configured on purpose — this is a public repo).

## Current suites

| Script | Needs Jira | Covers |
| --- | --- | --- |
| `dsh-jira-bundle-id.mjs` | no | package identity: `__ModuleLoader__.load({ id })` === `package.json.name` === `cordis.patch.yml insert[].name`, no `@local/` leftovers, client half still a `{ id, factory(require) }` bundle that imports no `@deepseek-ai/*` |
| `dsh-jira-visual.mjs` | no | rendering: grouping, collapse, project tabs, status filter, header total, priority highlight, **virtualization** (windowed DOM vs. placeholder height), **in-place status change** (no `/jira` re-fetch, local row + counts), fallback when `@tanstack/react-virtual` is missing |
| `dsh-jira-selfwatch.mjs` | no | the watch loop's diff: someone else's status change notifies, a change **you** made (panel POST or `jira_transition`) is swallowed and its baseline advanced, a colleague changing it right afterwards still notifies, a failed write leaves no stale expectation |
| `dsh-jira-plan.mjs` | no | the per-row **「计划」 button** end to end: a planning session is created in the project's linked workspace, `/plan` runs before the first message, that message carries the `JIRA_PLAN_SESSION:<KEY>` token plus the "only report the changes to make" / "stop if the issue is unclear" rules, a second click reuses the same session (local binding, then a token search through the session log), gaps are listed for a thin issue, and a missing workspace / plan-mode policy fails loudly |
| `dsh-jira-credential.mjs` | no | configure dialog + all six fetch routes: token/email save, verification and rejection, masked value, two-step clear, watch/language/fetch-size writes, paging (`--limit=0`, safety cap) |
| `dsh-jira-i18n.mjs` | no | language matrix (`DSH_JIRA_LANG`, `--lang`, `?lang`, config, host preference), Jira data kept verbatim, dictionary parity (zh/en key sets), host paging assertions, the "open `cordis.patch.yml`" route |
| `dsh-jira-platform.mjs` | no | **platform dispatch, verified without a VM**: forces `process.platform` and puts fake `cmd.exe` / `explorer.exe` / `rundll32.exe` / `powershell.exe` / `where` / `xdg-open` / `notify-send` shims on `PATH` that only log their `argv`, so every platform branch really spawns something and the test asserts the exact command + arguments (open / reveal / choose / custom app / editor picker / Unix `PATH` split / `X_OK` check / UNC patch path / `explorer.exe` exit code 1 / toast script and its AUMID fallback list) |
| `dsh-jira-release.mjs` | no | **release preflight** (no host deps, pure `fs` + `npm` + `git`): `package.json` is zero-dependency / `exports` + `files` targets exist / `publishConfig` points at the official registry, bundle identity agrees in all three places, `CHANGELOG.md` has a dated entry for the current version (and in `--release` mode it is the newest entry, `[Unreleased]` is empty and the tag matches), the repo is free of personal data (patterns are assembled from fragments so this file does not match itself), and `npm pack --dry-run` really contains every `files` entry with no `.git` / `node_modules` / token fragments |
| `dsh-jira-transition.mjs` | yes | `jira_transition`: listing transitions, preview vs. `apply`, invalid key / invalid transition id failure paths (never writes on the happy path) |
| `dsh-jira-status.mjs` | yes | end-to-end panel run against a real site (real 300+ item result, filter, abort on switch, virtualization); **skips itself with `SKIP:`** when Jira is unreachable, so a flaky network never looks like a regression |

Three older suites (`dsh-jira-client.mjs`, `dsh-jira-client2.mjs`, `dsh-jira-watch.mjs`) predated the 0.7+ panel redesign, kept failing ever since, and were removed in 0.13.1; `visual` + `credential` cover the same ground now.

## Older probes

`dsh-jira-smoke.mjs`, `dsh-jira-smoke3.mjs`, `dsh-jira-json.mjs`, `dsh-jira-sprint.mjs` and `dsh-jira-due.mjs` are the original probes from the first day (they print a report instead of asserting). They are kept because they are handy one-off diagnostics (`json` = raw `--json` payload, `sprint` = sprint field per issue, `due` = overdue issues across a project). Everything they can check offline runs first; the live-Jira part is wrapped so an unreachable site — including `example.atlassian.net`, which answers `404 Site temporarily unavailable` — prints `SKIP:` and exits 0, and a missing `JIRA_API_TOKEN` skips instead of failing.

## Screenshots

`dsh-jira-shot.mjs` is not a suite — it generates the README images in `docs/images/` and prints what it wrote. It is offline in the same way the visual suite is (real `client.js` components + the CSS they inject, driven by the mini React stand-in), then serializes the element tree to static HTML and shoots it with headless Chrome:

```bash
BIN="/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness"
ELECTRON_RUN_AS_NODE=1 "$BIN" test/dsh-jira-shot.mjs                    # en + zh, light
ELECTRON_RUN_AS_NODE=1 "$BIN" test/dsh-jira-shot.mjs --theme dark       # writes *-dark.png
ELECTRON_RUN_AS_NODE=1 "$BIN" test/dsh-jira-shot.mjs --only panel-watch
```

- The data is a fixed set of **made-up** APP/OPS issues (`demoPayload()`), so a shot can never leak a real site, account or issue summary — the empty theme variables fall back to the plugin's own colours if `app.asar` cannot be read. Every issue carries an epic (`APP-300` / `OPS-60`) or a parent, so the `↳ epic …` line is always on screen.
- Shots: `panel` (sprint grouping + `↳` lines + `☰ Plan` chips), `panel-plan` (two bound rows, `×` visible), `panel-watch` (change banner + status dropdown), `panel-search` (drives the real magnifier → field → Enter path and asserts the command面 got `--search=`), `panel-epic` (the real *By epic* toggle; asserts three group heads), `plan-flow` (a four-card walkthrough of linking a workspace and using the `☰ Plan` chip — drawn as a diagram, not a screenshot, because no real screenshot can show a context menu and the session switch), `sidebar-entry`.
- Row heights before shooting: the virtualizer stand-in starts from `estimateSize()` (32px), then `measureRows()` renders the whole list in headless Chrome, reads the real `.jmw-vrow` heights (real CSS decides), writes them back and re-renders — the same order the real library measures rows in. So group heads / rows with a `↳` line land exactly where the browser puts them.
- `--lang en,zh`, `--theme light|dark`, `--only panel|panel-plan|plan-flow|panel-watch|panel-search|panel-epic|sidebar-entry`, `--out <dir>` (default `docs/images`). Chrome and DSH's `app.asar` are looked up per platform (`findChrome()` / `findAsar()`: macOS `.app` bundles, the usual `Program Files` / `%LOCALAPPDATA%` locations on Windows, `google-chrome` / `chromium` / snap / flatpak plus `/opt` / `/usr/lib` / `/usr/share` install prefixes on Linux); `DSH_JIRA_CHROME` and `DSH_JIRA_ASAR` override, and without Chrome the script prints `SKIP:` and exits 0. Under root (Linux containers/CI) the run adds Chrome's `--no-sandbox`; pages are loaded through `pathToFileURL()`, so spaces and drive letters are fine.
- Inside the page CSS it neutralizes the panel's full-screen mask (`.jmw-mask{position:absolute;background:transparent}`) and drops a fake sidebar rail behind `sidebar-entry`, so the shots read as product UI rather than a floating overlay.

## Environment

- **Host-half import**: every suite calls `prepareHostCopy()` from `test/lib-host-runtime.mjs`, which copies the repo's `index.js` next to a copy of `@deepseek-ai/schemastery` + `cosmokit` in a temp dir (`DSH_INSTALL_DIR` is where DSH points at `<…>/dsh/node_modules/@deepseek-ai/dsh`; the dependency tree is one level up and is copied package by package because an `app.asar` directory cannot be symlinked). Override the location with `DSH_JIRA_TMP`; the default is `/tmp` when `/tmp/.dsh_jira_env` exists, otherwise `os.tmpdir()`. On a machine without DSH (or with `DSH_INSTALL_DIR` unset and nothing provisioned yet) the helper reports why and the suite prints `SKIP:` and exits 0 instead of dying on `ERR_MODULE_NOT_FOUND` — a fresh clone or a Linux/Windows box is a skip, not a failure.
- **Real-Jira suites** read a shell-style env file (`DSH_JIRA_ENV_FILE`, default `$TMP/.dsh_jira_env`, `chmod 600`) containing `JIRA_BASE_URL`, `JIRA_EMAIL` and `JIRA_API_TOKEN`. When the file does not exist the suites create it empty (`mode 0600`), so they run — and `SKIP` — on a machine that never built one; the values can also come from `JIRA_*` environment variables.
- **Screenshots** (`test/dsh-jira-shot.mjs`) locate headless Chrome per platform (`.app` on macOS, the usual `Program Files` locations on Windows, `google-chrome` / `chromium` / snap / flatpak on Linux) and print `SKIP:` + exit 0 when none is found; `DSH_JIRA_CHROME=<path>` overrides. Nothing in this repository contains a real token: every fixture token (`ATATT3xFfGF0…`) and every host (`example.atlassian.net`) is fake.
- **Project key**: the real-site suites need a project key for their labels and example issue keys. They take it from `DSH_JIRA_PROJECT`, else `JIRA_PROJECT` in that env file, else the made-up default `APP` — no real project key is stored in the repository.
- **Offline suites** never touch the network; their fake `fetch` is deterministic, and the client half runs against a tiny React stand-in (no real DOM), so timing-sensitive waits use explicit `settle()` polling.
