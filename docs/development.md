# Development Setup

Notes for working on AgEnD itself. For using AgEnD, see [features](features.md) and
the [CLI reference](cli.md).

## Point `gh` at the right repo

`origin` is `songsid/AgEnD` and `upstream` is `suzuke/AgEnD`. The `gh` CLI resolves
its default repo from the remote set, not from `origin`, so it can land on `upstream`
and fail in a way that reads like a git problem:

```
pull request create failed: GraphQL: Head sha can't be blank, Base sha can't be
blank, No commits between main and <your-branch>, Head ref must be a branch
```

The branch is pushed and fine — `gh` is just asking the wrong repo. Fix it once per
clone:

```bash
gh repo set-default songsid/AgEnD
```

Or pass `--repo songsid/AgEnD` on every invocation.

## Rebuild native modules after a Node version change

`better-sqlite3` is a native addon compiled against a specific Node ABI. Switching
Node versions (nvm, a system upgrade) leaves it built for the old one, and **every
SQLite-backed test fails at once** — well over a hundred — with:

```
The module '.../better_sqlite3.node' was compiled against a different Node.js
version using NODE_MODULE_VERSION 115. This version of Node.js requires
NODE_MODULE_VERSION 127.
```

```bash
npm rebuild better-sqlite3
```

Worth recognising on sight: a sudden mass failure across unrelated suites is this,
not a regression you just introduced.

## Tests

```bash
npm test                # vitest run — full unit suite, single pass
npm run test:integration # serial suites that use real tmux/child-process resources
npm run test:watch       # vitest watch mode
npm run test:e2e         # e2e suite (e2e/vitest.config.e2e.ts)
AGEND_CODEX_E2E=1 npx vitest run --config vitest.config.integration.ts tests/codex-exact-cwd-resume-e2e.test.ts
                      # opt-in: a real codex 0.155–0.159 resumes a worktree's own session (#984) and holds input while it loads; symlinks your ~/.codex/auth.json, sends no prompt
                      # run it against a new codex release before adding the version to SUPPORTED_CODEX in that file
npx vitest run tests/some-file.test.ts
```

The unit config excludes the integration suites and `e2e/**`. The integration
config runs its explicit suite list with file parallelism disabled; `test:integration`
also checks that the unit and integration configurations agree. Run the e2e
suite separately with its own configuration.

Two things the unit and integration configs handle for you, both of which used to
be able to kill a running production fleet from a test run:

- **`AGEND_HOME`** is set to a fresh temp directory per run. Without it,
  `getAgendHome()` falls back to the real `~/.agend`, and a `FleetManager` built in a
  test reads the live `instances/<name>/daemon.pid`.
- **`NOTIFY_SOCKET`** is blanked. Inherited from systemd, `FleetManager.stopAll()`'s
  `sdNotify("STOPPING=1")` would tell systemd to stop the real unit — a path that
  bypasses `AGEND_HOME` isolation entirely.

`tests/test-isolation.test.ts` asserts both are in effect, so a config regression
fails loudly instead of silently.

`dist/**` is excluded from collection. The build compiles `src/` and copies runtime
assets; it does not copy the top-level `tests/` directory. Tests colocated under
`src/` are still included in the TypeScript output, and old compiled tests can
remain in an existing `dist/`, so collect tests from source rather than those artifacts.

For a unit harness that constructs `FleetManager` or `Daemon`, stub the operational
boundaries before exercising them: lifecycle start/stop/wake/restart, detached
child-process launches, tmux operations, and HTTP/API listeners or calls. A temporary
`AGEND_HOME` and blank `NOTIFY_SOCKET` do not make real launch methods inert. Keep
the harness away from production daemon PIDs, tmux sessions, ports and adapters;
do not start a live fleet to test a unit path. Tests that intentionally need real
tmux or child processes belong in the integration configuration and must use
temporary data directories, private sockets, test ports and cleanup.

## Verifying before a PR

```bash
npm run typecheck        # tsc --noEmit
npm run typecheck:tests  # tsc --noEmit -p tsconfig.test.json
npm run build
npm test
npm run test:integration
```

`tsc --noEmit` and `npm run build` never construct a `FleetManager`, so they are safe
regardless of the above.

## Releases and CI

Four workflows live in `.github/workflows/`.

| Workflow | Runs on | Does |
|---|---|---|
| `ci.yml` | push and pull request to `main` | CHANGELOG fragment checks (below), `npm ci`, `tsc --noEmit`, `npm run typecheck:tests`, `npm run build`, `npm test`, `npm run test:integration` (Node 22) |
| `gitleaks.yml` | push and pull request to `main` | Secret scan of the full history |
| `deploy-website.yml` | push to `main` touching `website/**`, `src/tips.ts`, the tips generator or the package files; manual | Builds and deploys the GitHub Pages site |
| `publish.yml` | push of a tag matching `v*` | Publishes `@songsid/agend` to npm |

Each workflow ends with a Discord notification (secret `DISCORDWEBHOOK`;
skipped when unset). `ci.yml`, `gitleaks.yml` and `deploy-website.yml` post
only failures; `publish.yml` posts every outcome. The notification never
changes the run's result.

### CHANGELOG fragments

A PR does not edit [`CHANGELOG.md`](CHANGELOG.md) or
[`CHANGELOG.zh-TW.md`](CHANGELOG.zh-TW.md). It adds its entry as two files in
`changes/`, and the entries are moved into the CHANGELOG in one commit, so two
PRs never conflict on it. `changes/1328.md`:

```markdown
---
section: Fixed
---
- **A working agy is seen as working (#1328).** agy's working row is …
```

`changes/1328.zh-TW.md`:

```markdown
---
section: Fixed
---
- **工作中的 agy 會被看成工作中（#1328）。** agy 工作中的那一列是 …
```

- A PR that changes nothing a package user would notice (CI, tests, these
  docs) adds no fragment.
- The name is `<issue>.md`, or `<issue>-<slug>.md` for a second entry on the
  same issue, and its zh-TW pair is the same name with `.zh-TW.md`. Both are
  required.
- `section` is one of `Upgrade Notes`, `Added`, `Changed`, `Fixed` or
  `Security`, and both languages name the same one. There is no other key.
- The body is one or more list items, written exactly as they should appear,
  following [CHANGELOG entries](#changelog-entries). No headings: the
  subsection comes from `section`.

[`scripts/changelog-assemble.mjs`](../scripts/changelog-assemble.mjs) moves
them:

```bash
node scripts/changelog-assemble.mjs                                 # into ## [Unreleased]
node scripts/changelog-assemble.mjs --release X.Y.Z --date YYYY-MM-DD  # into ## [X.Y.Z] - YYYY-MM-DD
node scripts/changelog-assemble.mjs --check                         # validate only
```

- It validates every fragment first, and one bad fragment writes nothing.
- Entries go to the top of their subsection, ordered by issue number. A
  missing subsection is created in the order below. A missing release section
  is created right under `[Unreleased]`.
- It deletes the fragments it moved. An entry already in the target section is
  not added twice, so rerunning it is harmless.
- Commit its result with the trailer `Changelog: assemble` on a line of its
  own; the script prints it.

`ci.yml` checks both rules, before `npm ci`:

- `changelog-assemble.mjs --check` fails on a fragment that does not parse,
  names an unknown section, or has no pair.
- On a pull request,
  [`scripts/changelog-guard.mjs`](../scripts/changelog-guard.mjs) fails when
  the PR changes `docs/CHANGELOG*.md`, counted from the merge-base, so a
  merge-sync from `main` does not count. The exception is a PR whose every
  commit editing them carries the `Changelog: assemble` trailer.

### Cut the CHANGELOG section before tagging

Entries collect under `## [Unreleased]` in both
[`CHANGELOG.md`](CHANGELOG.md) and [`CHANGELOG.zh-TW.md`](CHANGELOG.zh-TW.md).
A stable release moves them into its own section in the same PR that prepares
the tag, so the tagged commit already carries its notes:

1. Assemble the fragments first:
   `node scripts/changelog-assemble.mjs --release X.Y.Z --date YYYY-MM-DD`,
   dated the day the tag is pushed. This creates `## [X.Y.Z] - YYYY-MM-DD`
   under `## [Unreleased]` in both files and moves every fragment into it.
   Leave out a fragment whose change is not in the release by moving it out
   of `changes/` first. Commit with the `Changelog: assemble` trailer. Check
   the date afterwards with `git log -1 --format=%cs vX.Y.Z`.
2. Move every entry already under `[Unreleased]` whose change is in the
   release into the new section, Upgrade Notes included, in the same commit.
   When in doubt, an entry belongs to the first tag whose history contains the
   commit that added it: `git merge-base --is-ancestor <sha> vX.Y.Z`.
3. Order its subsections `### Upgrade Notes`, `### Added`, `### Changed`,
   `### Fixed`, `### Security`, leaving out empty ones. The assembler already
   does this for what it adds. The zh-TW file uses the same subsections
   (`升級注意事項 (Upgrade Notes)` and so on) and the same entries.
4. Leave only unreleased work under `## [Unreleased]`.

Betas and alphas do not get their own section. Before tagging one, run the
assembler without `--release`, so its fragments land under `[Unreleased]`
until the stable release that ships them.

### Publishing

A release is a pushed tag. `publish.yml`:

1. Takes the version from the tag (`v2.1.9` → `2.1.9`) and fails on anything
   that is not a `v*` tag or contains characters outside `[0-9A-Za-z.+-]`.
2. Picks the npm dist-tag with
   [`scripts/npm-dist-tag.mjs`](../scripts/npm-dist-tag.mjs) (#1259):

   | Tag | npm dist-tag |
   |---|---|
   | `vX.Y.Z` | `latest` |
   | `vX.Y.Z-beta.N` | `beta` |
   | `vX.Y.Z-alpha.N` | `alpha` |
   | anything else (`-rc.1`, `-beta`, leading zeros…) | the job fails |

   A stable version older than the current `@latest` is refused, so `latest`
   never moves backwards. If the lookup of the current `@latest` fails, only
   that check is skipped.
3. Installs npm 11, then `npm ci`, `tsc --noEmit`, `npm run build`. Tests are
   not rerun here; they ran in CI on `main`.
4. Sets the package version from the tag (`npm pkg set`; the `version` in
   `package.json` on `main` is not the released one), repeats the dist-tag
   check against a fresh `@latest`, and runs
   `npm publish --access public --tag <dist-tag>`.

Authentication is npm trusted publishing (OIDC): the workflow has
`id-token: write` and no npm token secret, and npm 11 is installed because it
supports OIDC. The trusted-publisher binding itself is configured on npmjs.com,
not in this repository.

`concurrency: npm-publish` with `cancel-in-progress: false` runs one release at
a time, so the "read latest → compare → publish" sequence cannot interleave
with another release. GitHub keeps only one pending run per group: if two more
tags queue behind a running release, the older pending one is cancelled and
publishes nothing; re-run it or push its tag again.

The workflow does not create a GitHub Release, and there is no separate
Discord plugin package to build: Discord is built into the main package.

### Channels

| Channel | Tag | Install |
|---|---|---|
| Stable | `vX.Y.Z` | `npm install -g @songsid/agend` |
| Beta | `vX.Y.Z-beta.N` | `npm install -g @songsid/agend@beta` |
| Alpha | `vX.Y.Z-alpha.N` | `npm install -g @songsid/agend@alpha` |

`agend update` stays on the channel of the installed version: an alpha follows
`@alpha`, any other prerelease `@beta`, a release `@latest`
(`installedChannel` in `src/update-check.ts`). `--alpha`, `--beta` and
`--stable` switch channels; an update that would go back to an older version
is refused unless asked for.

## Release notes style

[`docs/CHANGELOG.md`](CHANGELOG.md) and GitHub Release notes are different
documents. The CHANGELOG is the detailed record, in
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) form. Release notes are the
short, user-facing summary of the same release. CI never writes either; a
GitHub Release is created by hand.

### CHANGELOG entries

Every released entry since 2.1.4 opens with `### Upgrade Notes`, before
`### Added` and `### Fixed` (and `### Security` / `### Changed` when used).
Upgrade Notes holds what someone upgrading must know before they do it:

- behaviour that changes for an existing setup, each such item prefixed
  **[Behaviour change]** (for example, 2.1.6: agents no longer get every tool
  by default);
- anything that needs action or an explicit config entry (for example, 2.1.5:
  `/restart full` with an empty `allowed_users` is now refused);
- migrations AgEnD performs on its own, what they touch, and whether rolling
  back is safe (for example, 2.1.8: Codex app-server directories);
- new settings that are off or opt-in, with their default (for example, 2.1.9:
  `delivery_worker`).

Each item is a bold one-line summary with the issue number, followed by enough
explanation to decide whether it affects you. Leave the section out only when
there is genuinely nothing to say; do not fill it with ordinary features.

### GitHub Release notes

Modelled on [Outline's releases](https://github.com/outline/outline/releases):

```markdown
## What's Changed

### Upgrade Notes
(only when the CHANGELOG has them: one line each, behaviour changes first)

### Highlights
(the 2–3 changes users will notice most, with a sentence or two on why they matter)

### Improvements
(one line each)

### Fixes
(one line each)

**Full Changelog**: https://github.com/songsid/AgEnD/compare/vPREVIOUS...vTHIS
```

- English. No emoji as section headings.
- Written for people who install the npm package, not for contributors: no PR
  links, and leave out changes that do not affect the package (website, install
  scripts, GitHub Pages).
- One line per item; only Highlights get more.
- The compare link runs from the previous release on the same channel to this
  one, for example
  [`v2.1.8...v2.1.9`](https://github.com/songsid/AgEnD/compare/v2.1.8...v2.1.9).
