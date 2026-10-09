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

Regular checks and publishing workflows live in `.github/workflows/`.

| Workflow | Runs on | Does |
|---|---|---|
| `ci.yml` | PR/branch push to `main` or `release/**`; `v*` tag; manual; weekly | CHANGELOG fragments, typecheck/build, four unit shards and integration (Node 22), install smoke and Node 20 rollback. PR/branch runs use Linux; tag/manual/weekly also test macOS. |
| `gitleaks.yml` | push and pull request to `main` | Secret scan of the full history |
| `data-downgrade.yml` | push and pull request to `main` | Linux scratch-store current → published 2.1.12 → current roundtrip |
| `npm-rollback-proof.yml` | relevant PRs; branch push; `v*` tag; manual; weekly | npm 9/10/11 refused-install rollback proof on Linux; deferred events also test macOS |
| `deploy-website.yml` | push to `main` touching `website/**`, `src/tips.ts`, the tips generator or the package files; manual | Builds and deploys the GitHub Pages site |
| `publish.yml` | push of a tag matching `v*` | Publishes `@songsid/agend` to npm |

See [CI coverage and scheduling](ci.md) ([繁體中文](ci.zh-TW.md)) for runner
selection, PR cancellation and the gate's absent-versus-skipped distinction.
Runtime acceptance and runtime publishing have separate workflows.

`ci.yml`, `gitleaks.yml`, `deploy-website.yml` and `publish.yml` end with a
Discord notification (secret `DISCORDWEBHOOK`; skipped when unset).
`ci.yml`, `gitleaks.yml` and `deploy-website.yml` post
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
  subsection comes from `section`. Indent the lines that continue an item.
  Text after a blank line that is neither indented nor a new `- ` item is
  refused, because it would land outside the list.

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
- It deletes the fragments it moved. An entry already in the target section
  (the whole entry, not a line that starts the same) is not added twice, so
  rerunning it is harmless. If a run stopped between deleting the two halves
  of a pair, `--check` reports the half left behind, and running the assembler
  again with the same target removes it.
- Commit its result with the trailer `Changelog: assemble` on a line of its
  own; the script prints it.

`ci.yml` checks both rules, before `npm ci`:

- `changelog-assemble.mjs --check` fails on a fragment that does not parse,
  names an unknown section, or has no pair.
- On a pull request,
  [`scripts/changelog-guard.mjs`](../scripts/changelog-guard.mjs) counts from
  the merge-base, so what a merge-sync brought in from `main` is not the PR's
  change. It fails when:
  - a commit of the PR edits `docs/CHANGELOG*.md` without the
    `Changelog: assemble` trailer;
  - an entry the PR adds to or removes from them came from no marked commit.
    That covers an edit slipped into a merge, or a conflict resolved to one
    side that dropped the other side's entries. A merge that resolves a
    CHANGELOG conflict on purpose carries the trailer too;
  - a fragment the PR deletes does not have its entry in the CHANGELOG.

#### A long-lived line landing on `main`

A feature line that kept its own CHANGELOG section, such as
`feature/2.2-web` and its `## [2.2.0] - unreleased (web line, …)`, gets no
exemption from the guard. The PR that lands it on `main` converts that
section into fragments:

1. Merge-sync the line with `main` first.
2. For each entry the line added, add `changes/<issue>.md` and
   `changes/<issue>.zh-TW.md` with the same text and the section it was
   under. An entry without an issue number uses the landing PR's number with
   a slug, for example `changes/1262-web-chat-markdown.md`.
   [`scripts/changelog-split.mjs`](../scripts/changelog-split.mjs) does this
   for a whole release section, removing it from both files:
   `node scripts/changelog-split.mjs --release 2.2.0 --issue <landing PR> --dry-run`,
   then the same without `--dry-run`. It pairs the en and zh-TW entries per
   subsection, in order. It refuses, writing nothing, when the counts differ,
   when the two halves of a pair name different issues, or when a target file
   already exists (unless `--force`).
3. Drop the fragments for entries that only concerned the line itself, such
   as its temporary CI.
4. Put both CHANGELOGs back to `main`'s version, so the PR no longer changes
   them:
   `git checkout origin/main -- docs/CHANGELOG.md docs/CHANGELOG.zh-TW.md`.
5. `node scripts/changelog-assemble.mjs --check` and commit.

The guard counts from the merge-base, so the line's old commits that edited
the CHANGELOG no longer matter once the files equal `main`'s.

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

## Merge gate

A reviewed PR is merged by
[`scripts/gate-merge.sh`](../scripts/gate-merge.sh), not by hand. The
coordinator runs an installed copy, `~/.agend/scripts/gate-merge.sh`, when the
reviewer's approval arrives:

```bash
# delivery_status is an MCP tool: save its result for the approval message and pipe it in.
gate-merge.sh [--dry-run] [--delivery-json <file>|-] <pr> <approved-sha> <approval-message-id>
```

**The approval is a line of its own.** The reviewer writes the verdict at the
start of a line, binding the PR and the full head SHA together:

```
APPROVE — PR #1334 @d719d476b28ae36067f8815b6956162a5e1c27ed
```

The dash, `PR` and `@` are optional, and one message may carry several such
lines for several PRs. A mention anywhere else (another line, a quote, another
PR's verdict) grants nothing.

**The delivery JSON is trusted input.** The caller must pass exactly what its
own `delivery_status` call returned. `content_sha256` is checked against the
content, but a hash does not prove where the message came from.

Run the gate from a clone whose `origin` is the repository. It fetches into
`refs/gate/*` only and never moves a local branch. It merges only when all of
these hold:

1. **The approval is verified.** The delivery has that message id, comes from
   the reviewer (`GATE_APPROVER`, default `agend-reviewer`), its content
   matches its `content_sha256`, and it has the verdict line above for this PR
   and SHA.
2. **The PR is open** and not a draft, and the fetched `refs/pull/<n>/head` is
   the head gh reports.
3. **The head is the approved SHA**, or a descendant of it whose own change is
   unchanged:
   - **Identical tree.**
   - **The same fingerprint of its own change.** That is its diff from the
     merge-base with the base branch, every byte of whitespace kept, with only
     `index` lines and hunk line numbers normalised. So a merge-sync carries
     the approval, and a whitespace change inside a string does not.

   This is compared on every path except `docs/` and `changes/`. Anything else
   prints `NEEDS_REVIEW <paths>`, and the reviewer re-confirms.
4. **The base branch tip is an ancestor** of the head.
5. **CI passed in full on the exact head.** Every required check has a run, and
   every run (the latest of each name) is completed with `success`. A skipped
   or neutral run does not count. The required checks are
   `GATE_REQUIRED_CHECKS` (default: `main`'s gate, `build`, `scan`, `CodeQL`,
   `Analyze (javascript-typescript)` and `Analyze (actions)`) plus any that a
   ruleset on the base branch requires.

It then retargets open PRs based on this branch to this PR's base, and
squash-merges with `--match-head-commit`. It deletes the branch only when no
open PR is based on it any more.

**A gh write that reports failure is read back before anything else
happens.**
- A retarget or merge that did happen counts as done.
- One that did not is rolled back: the retargets go back to this branch.
- If the read-back fails too, the result is `BLOCKED uncertain: …` and nothing
  more is changed or reverted.

Any git or gh read that fails blocks.

The output is one line: `MERGED <merge sha>` (exit 0), `WOULD_MERGE <head>`
with `--dry-run` (exit 0, nothing changed), `BLOCKED <reason>` (exit 1) or
`NEEDS_REVIEW <paths>` (exit 3).

After changing the script, install it again:
`install -m 755 scripts/gate-merge.sh ~/.agend/scripts/gate-merge.sh`.
