# AGENTS.md — working on `dsh-jira-work-overview`

A DeepSeek Harness (DSH) plugin that shows the Jira work items assigned to you: a left-sidebar panel
(project tabs, status filter, sprint grouping, virtualization, accurate totals), three agent tools, a
`/jira` slash command, live change badge + desktop notifications, workflow-state transitions, and
in-panel token / email / watch / fetch-size configuration.

**The plugin is two halves with no build step** — whatever you write in `index.js` / `client.js` is what
DSH serves. There is no bundler, no `lib/`, no dependencies for the client half.

## Repo layout

| Path | What it is |
| --- | --- |
| `index.js` | Host half. `Config` (schemastery) + `apply(ctx)`: 3 tools, `/jira` command, **4 exact Fetch routes** under `/api/jira-work-overview/*`, the background watch loop, JQL building, both JSON payloads and the Markdown renderers, the `TEXT = { zh, en }` dictionary |
| `client.js` | Client half. `window.__ModuleLoader__.load({ id, factory })`; renders the panel, the configure dialog and the config-page contributions; the `M = { zh, en }` dictionary |
| `cordis.patch.yml` | The bundle patch DSH inserts into a profile. **Neutral defaults only** — no personal site/email/project values |
| `locale/{en,zh}.json` | Plugin-list metadata (title + description) only; runtime copy lives in the dictionaries |
| `icon.svg` | Plugin icon (`./icon` export) |
| `test/*.mjs` | Plain Node scripts (no framework). See `test/README.md` |
| `docs/images/*.png` | README screenshots — generated, never hand-edited; regenerate with `test/dsh-jira-shot.mjs` |
| `CHANGELOG.md` | Keep a Changelog, one entry per released version |
| `README.md` / `README.zh.md` | User docs (English first, Chinese mirror) |

## Dev loop

```bash
BIN="/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness"
ELECTRON_RUN_AS_NODE=1 "$BIN" --check index.js && ELECTRON_RUN_AS_NODE=1 "$BIN" --check client.js
ELECTRON_RUN_AS_NODE=1 "$BIN" test/dsh-jira-bundle-id.mjs  # offline (package/bundle identity; run it after any rename)
ELECTRON_RUN_AS_NODE=1 "$BIN" test/dsh-jira-visual.mjs      # offline (rendering, virtualization)
ELECTRON_RUN_AS_NODE=1 "$BIN" test/dsh-jira-credential.mjs  # offline (config dialog + all 4 routes)
ELECTRON_RUN_AS_NODE=1 "$BIN" test/dsh-jira-i18n.mjs        # offline (language matrix + paging)
ELECTRON_RUN_AS_NODE=1 "$BIN" test/dsh-jira-status.mjs      # needs a real site; SKIPs when unreachable
ELECTRON_RUN_AS_NODE=1 "$BIN" test/dsh-jira-transition.mjs  # needs a real site (never writes)
```

Then reload the plugin in DSH and refresh the page:

1. `plugin_manager` → `remove_bundle` (target `dsh-jira-work-overview`), then `install_bundle` with
   `target="<absolute path to this checkout>"`.
2. `install_bundle` returns `application: applied` — **that is not the same as activated.** Confirm with
   `list_plugins` that the row shows `fiberPhase: "active"`, and watch for activation diagnostics
   (`… did not activate`, `未注册…通道`): a host crash during `apply()` still reports `applied`.
3. Reload the DSH page; the entry appears above Settings in the left sidebar.

The real-site suites read a shell-style env file (`$DSH_JIRA_ENV_FILE`, default `$DSH_JIRA_TMP/.dsh_jira_env`)
with `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN` (and, for the real-site suites' project labels,
`JIRA_PROJECT` — they fall back to a made-up `APP`). **Never commit a token**; nothing in this repo
contains one — every fixture token and host is fake (`ATATT3xFfGF0…`, `example.atlassian.net`).

## Invariants that are easy to break

- **Client half imports only platform modules**: `react`, `react-dom`, `@tanstack/react-virtual` are in
  DSH's module table. Never `require` an `@deepseek-ai/*` package from `client.js`, and never add a
  build step.
- **`package.json.name`, `cordis.patch.yml`'s `insert[].name` and `client.js`'s
  `window.__ModuleLoader__.load({ id })` must all be the same string** — DSH resolves the module by it, and
  the host composes the client boot graph by package name. A mismatched bundle id fails only with
  `client-modules: bundle <url> loaded without registering "<package>" via __ModuleLoader__.load`: the whole
  browser half (sidebar entry, panel, config pages) goes dark while the host row still reads `active`.
  `test/dsh-jira-bundle-id.mjs` pins all three. The `@local/` scope only works for local `link:` installs;
  keep the publishable name.
- **Config the panel edits must be `.volatile()`** in the host `Config` and written through
  `ctx.get('settings').mutate(ns, ops, revision)` (ns = the patch row id `jira-work-overview`). Volatile
  fields are reference objects at runtime: read them with `liveSetting()` / `.get()`, never as plain values,
  and re-read per operation so a change takes effect immediately.
- **No secret ever leaves the credential store.** `ctx.get('credentials')` with `credentialKey`
  (`JIRA_API_TOKEN`); responses carry `masked` + `length` only.
- **All user-facing copy goes through the dictionaries** (`TEXT` host-side, `M` client-side, zh + en key
  sets identical). Jira-returned data is always rendered verbatim — never translate it, never "fix" it.
  Host i18n resolves per operation (`DSH_JIRA_LANG` → `--lang=` / `?lang=` → Config `language` →
  `locale.preference` → panel-reported language → OS env → ICU → `en`).
- **Tests must SKIP, not fail, when the network or site is down** (`SKIP: …` + `exit 0`), and offline
  suites must stay offline. Test hooks (`onNotify`, `onOpenPatch`, `onDetectEditors`) must be passed as a
  **raw config object** to `apply()` — `host.Config()` strips undeclared fields. When a suite calls
  `apply()` more than once in one process, route assertions must use the **last** registration.
- **Keep personal data out of the repo**: the shipped `cordis.patch.yml` holds neutral defaults; a user's
  site/email/project values belong in their own profile patch.

## Release checklist

**Releases are requested, not automatic.** Day-to-day work is committed and pushed; a version bump, the
`CHANGELOG.md` entry, the tag and the GitHub Release happen only when the maintainer asks for a release —
one iteration may collect several changes that ship as a single version. When that go-ahead comes:

0. **Freeze the release content first, and tag exactly that commit.** The GitHub tag and the npm tarball
   must contain the same bytes: bump `package.json.version`, write the `CHANGELOG.md` entry, finish the
   README (install spec, `publishConfig`) *before* tagging — publishing npm afterwards from a later commit
   leaves GitHub and npm showing two different `README.md` / `CHANGELOG.md` / `package.json` for the same
   version. If that already happened, move the tag onto the commit you packed from (`git tag -f vX.Y.Z
   <sha>` → `git push --force-with-lease=refs/tags/vX.Y.Z:<old sha> origin refs/tags/vX.Y.Z`); the GitHub
   Release follows the tag name. Verify with a fresh anonymous clone at the tag:
   `git -c credential.helper= clone --depth 1 --branch vX.Y.Z <url> tag` and `cmp` every file listed in
   `files` against the extracted npm tarball — `codeload…/tar.gz/refs/tags/vX.Y.Z` may still serve a
   **cached** archive for a while, so do not trust it right after moving a tag.
1. Bump `package.json.version`, add the `CHANGELOG.md` entry, `git add -A && git commit` (if the release
   bundles work already on `main`, fold the `[Unreleased]` notes into the new version section so the
   release notes match the tag's content).
2. `git push origin main`.
3. `gh release create vX.Y.Z --target main --title "vX.Y.Z — …" --notes-file notes.md` (notes: what it does,
   what changed, the copy-paste install spec, requirements, link to the changelog). For a release that is
   **not** the newest, pass `--latest=false`; if the tag is not at `HEAD`, create it locally first
   (`git tag -a vX.Y.Z <sha> -m … && git push origin vX.Y.Z`) — `gh --target <short sha>` fails.
4. `npm publish` (the `publishConfig` in `package.json` pins `https://registry.npmjs.org` — the machine's
   default registry is a mirror, so without it the upload goes to the wrong place). Two things to know:
   the registry may accept the upload as a **staged** publish instead of making it live — you then see
   `409 Conflict - Cannot publish over previously staged version "X.Y.Z"` on a retry, the package page
   shows a `0.0.0-stage` placeholder (its readme says "awaiting a staged release"), and the real version
   appears only after a maintainer **approves** it with 2FA (npmjs.com → the package's *Staged Packages*
   tab → Approve; the button stays disabled until npm's malware scan finishes and the page auto-refreshes
   every minute). `npm stage list` may report nothing even while the version is staged, so trust the
   registry state, not the CLI. **Verify before reporting success**: `npm view <pkg>@X.Y.Z dist.shasum`
   must equal the shasum of your local `npm pack`, and `npm view <pkg> dist-tags` must point `latest` at
   the new version — a successful-looking `npm publish` proves nothing.

## Install spec (how users get it)

```bash
plugin_manager install_bundle(target="dsh-jira-work-overview")                   # npm, live since 0.14.0
plugin_manager install_bundle(target="github:EagleSoap/dsh-jira-work-overview")  # no npm release needed
```

The client half needs no build; DSH serves the declared `./client` file.

## Known open items (as of 0.13.4)

- **0.13.3's two reported fixes were confirmed in a real browser** (user-verified 2026-11-19, DSH Desktop
  0.2.2-rc.3): group headers no longer overlap after "collapse all", and scrolling no longer flashes the
  screen — so the fork's `directDomUpdates: true` lever stays unused. What the offline suite still cannot
  exercise is the real `@tanstack/react-virtual` path itself: its stand-in ignores
  `getItemKey`/`estimateSize`, so `scrollToIndex` resets and row measurement remain browser-only.
- Windows / Linux were implemented by platform dispatch but never run on those systems (only macOS here).
- Truncation above the 5000-item safety net is covered by host stubs only.
- Five first-day diagnostic probes remain in `test/` (they print reports instead of asserting) — kept as
  handy one-offs.
