# Tests

All suites are plain Node scripts (`node:assert`-style checks, no test framework) and must run under DSH's own binary with `ELECTRON_RUN_AS_NODE=1`, because the host half imports `@deepseek-ai/schemastery`, which only resolves inside the app.

```bash
BIN="/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness"
ELECTRON_RUN_AS_NODE=1 "$BIN" test/<script>.mjs
```

## Current suites

| Script | Needs Jira | Covers |
| --- | --- | --- |
| `dsh-jira-bundle-id.mjs` | no | package identity: `__ModuleLoader__.load({ id })` === `package.json.name` === `cordis.patch.yml insert[].name`, no `@local/` leftovers, client half still a `{ id, factory(require) }` bundle that imports no `@deepseek-ai/*` |
| `dsh-jira-visual.mjs` | no | rendering: grouping, collapse, project tabs, status filter, header total, priority highlight, **virtualization** (windowed DOM vs. placeholder height), fallback when `@tanstack/react-virtual` is missing |
| `dsh-jira-credential.mjs` | no | configure dialog + all four fetch routes: token/email save, verification and rejection, masked value, two-step clear, watch/language/fetch-size writes, paging (`--limit=0`, safety cap) |
| `dsh-jira-i18n.mjs` | no | language matrix (`DSH_JIRA_LANG`, `--lang`, `?lang`, config, host preference), Jira data kept verbatim, dictionary parity (zh/en key sets), host paging assertions, the "open `cordis.patch.yml`" route |
| `dsh-jira-transition.mjs` | yes | `jira_transition`: listing transitions, preview vs. `apply`, invalid key / invalid transition id failure paths (never writes on the happy path) |
| `dsh-jira-status.mjs` | yes | end-to-end panel run against a real site (real 300+ item result, filter, abort on switch, virtualization); **skips itself with `SKIP:`** when Jira is unreachable, so a flaky network never looks like a regression |

Three older suites (`dsh-jira-client.mjs`, `dsh-jira-client2.mjs`, `dsh-jira-watch.mjs`) predated the 0.7+ panel redesign, kept failing ever since, and were removed in 0.13.1; `visual` + `credential` cover the same ground now.

## Older probes

`dsh-jira-smoke.mjs`, `dsh-jira-smoke3.mjs`, `dsh-jira-json.mjs`, `dsh-jira-sprint.mjs` and `dsh-jira-due.mjs` are the original probes from the first day (they print a report instead of asserting). They are kept because they are handy one-off diagnostics (`json` = raw `--json` payload, `sprint` = sprint field per issue, `due` = overdue issues across a project).

## Screenshots

`dsh-jira-shot.mjs` is not a suite — it generates the README images in `docs/images/` and prints what it wrote. It is offline in the same way the visual suite is (real `client.js` components + the CSS they inject, driven by the mini React stand-in), then serializes the element tree to static HTML and shoots it with headless Chrome:

```bash
BIN="/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness"
ELECTRON_RUN_AS_NODE=1 "$BIN" test/dsh-jira-shot.mjs                    # en + zh, light
ELECTRON_RUN_AS_NODE=1 "$BIN" test/dsh-jira-shot.mjs --theme dark       # writes *-dark.png
ELECTRON_RUN_AS_NODE=1 "$BIN" test/dsh-jira-shot.mjs --only panel-watch
```

- The data is a fixed set of **made-up** APP/OPS issues (`demoPayload()`), so a shot can never leak a real site, account or issue summary — the empty theme variables fall back to the plugin's own colours if `app.asar` cannot be read.
- `--lang en,zh`, `--theme light|dark`, `--only panel|panel-watch|sidebar-entry`, `--out <dir>` (default `docs/images`). Chrome is looked up at `/Applications/Google Chrome.app/…` (override with `DSH_JIRA_CHROME`); without it the script prints `SKIP:` and exits 0.
- Inside the page CSS it neutralizes the panel's full-screen mask (`.jmw-mask{position:absolute;background:transparent}`) and drops a fake sidebar rail behind `sidebar-entry`, so the shots read as product UI rather than a floating overlay.

## Environment

- **Host-half import**: the suites copy `index.js` next to a copy of `@deepseek-ai/schemastery` in a temp dir. Override the location with `DSH_JIRA_TMP`; the default is `/tmp` when `/tmp/.dsh_jira_env` exists, otherwise `os.tmpdir()`.
- **Real-Jira suites** read a shell-style env file (`DSH_JIRA_ENV_FILE`, default `$TMP/.dsh_jira_env`, `chmod 600`) containing `JIRA_BASE_URL`, `JIRA_EMAIL` and `JIRA_API_TOKEN`. Nothing in this repository contains a real token: every fixture token (`ATATT3xFfGF0…`) and every host (`example.atlassian.net`) is fake.
- **Offline suites** never touch the network; their fake `fetch` is deterministic, and the client half runs against a tiny React stand-in (no real DOM), so timing-sensitive waits use explicit `settle()` polling.
