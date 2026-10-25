# Releasing

The checklist for cutting an AgEnD release: a beta, then a stable one. Only the
coordinator bumps the version and pushes the tag. Pushing a `v*` tag runs
`.github/workflows/publish.yml`, which publishes to npm. The leader verifies the
result and creates the GitHub release. Nothing here starts without the user's
explicit go.

How the dist-tag is chosen: `publish.yml` runs `scripts/npm-dist-tag.mjs`.
- `X.Y.Z` goes to `latest`. It is refused if that would move `latest` backwards.
- `X.Y.Z-beta.N` goes to `beta`.
- `X.Y.Z-alpha.N` goes to `alpha`.
- Any other version is refused.

So a beta never moves `latest`.

## Beta

1. **Each PR carries:**
   - its CHANGELOG fragment pair, `changes/<issue>[-slug].md` and
     `.zh-TW.md` (see [development.md](../development.md), "CHANGELOG
     fragments"). The `changelog` job in `ci.yml` validates every fragment
     (`scripts/changelog-assemble.mjs --check`) and refuses direct CHANGELOG
     edits (`scripts/changelog-guard.mjs`). It does not require a PR to add
     one, so the reviewer checks that a user-facing change has its pair;
   - the `docs/` pages the change affects;
   - an entry in `src/agent-whats-new.ts` when a tool parameter an agent
     sees changes. Instances that were already running are told about it
     once.
2. **Main CI is green on the candidate SHA.**
3. **The user gives an explicit go.** It must be a Discord, Telegram or
   web-verified receipt, never a plain "via web" message. The leader then
   delegates the release to the coordinator and forwards the receipt. The
   coordinator:
   - bumps the version;
   - tags `vX` on the release commit and pushes the tag. `publish.yml`
     publishes the package under the `beta` dist-tag, and `latest` is
     unchanged.
4. **The leader verifies:**
   - `git rev-parse vX^{commit}` is the release commit;
   - the registry's dist-tags, read with `Cache-Control: no-cache`. The
     registry lags a few minutes after a publish, so re-read it before
     calling it missing.
   - Then the leader runs
     `gh release create vX --verify-tag --prerelease --notes-file <file>`.
5. **Not done for a beta:**
   - website content. A website merge deploys at once (decision 813e85d2),
     so the website must never describe an unreleased version;
   - the README;
   - CHANGELOG assembly. Fragments stay in `changes/` until the stable
     release.
6. **Rehearsal:** run one only when update, install, service, launcher or
   runtime pins changed. It runs in parallel with the beta and does not block
   it.

## Stable (e.g. 2.3.2), in order

1. **Scope.**
   - List the milestone's issues.
   - Move deferred issues to the next version's milestone.
   - Confirm there is no open P1.
2. **Acceptance.**
   - Run the real-machine checks: the Windows install, restart recovery, the
     real-Mac rehearsal.
   - The macOS legs run on the tag: `ci.yml` tests macOS on a `v*` tag, and
     `npm-rollback-proof.yml` and `runtime-acceptance.yml` also run on `v*`
     tags.
3. **Upgrade rehearsal**, when the upgrade path changed:
   - previous stable → new;
   - beta → stable;
   - rollback, new → previous stable.
4. **CHANGELOG.** Follow [development.md](../development.md), "Cut the
   CHANGELOG section before tagging". In short:
   - `node scripts/changelog-assemble.mjs --release X.Y.Z --date YYYY-MM-DD`
     creates `## [X.Y.Z] - <date>` in `docs/CHANGELOG.md` and
     `docs/CHANGELOG.zh-TW.md`, moves every fragment in `changes/` into it and
     deletes the fragments.
   - First move out of `changes/` any fragment whose change is not in the
     release.
   - Commit with the `Changelog: assemble` trailer. Without it,
     `scripts/changelog-guard.mjs` refuses the CHANGELOG edit in CI.
   - Move the entries already under `[Unreleased]` that belong to this
     release into the new section, in the same commit.
   - `scripts/changelog-split.mjs` is the reverse operation: it turns a
     release section back into fragments, for a long-lived line landing on
     `main`. A normal release does not use it.
5. **Release notes.** Write `docs/release-notes/<version>.md` and
   `.zh-TW.md`. They hold the user-facing highlights, not the full
   changelog. The same text goes in the GitHub release.
6. **What's new.**
   - A minor release gets a new `docs/whats-new-<x.y>.md` and `.zh-TW.md`
     (as `docs/whats-new-2.3.md`), and the website's what's new page
     (`website/src/content/docs/docs/whats-new.md` and its `zh-tw`
     counterpart).
   - A patch release adds a short section to the current page, or nothing.
7. **Docs pass.** Compare the version's merged PRs against `docs/`:
   - features (`docs/features.md`);
   - install: the README's Quick Start (`README.md`, `README.zh-TW.md` "開始用")
     and the Windows install page (`website/src/pages/install-windows.astro`
     and its `zh-tw` copy);
   - upgrade (`docs/upgrade-<x.y>.md`);
   - the config reference (`docs/configuration.md`);
   - the CLI reference (`docs/cli.md`).
8. **i18n audit (EN / zh-TW).**
   1. **Automated checks.** These run in CI. Run them locally with
      `npx vitest run <file>` when you want to see them:
      - `tests/i18n-ui-literals-2390.test.ts`: English written in place in
        `src/ui` (text nodes, literal aria-label / title / placeholder and
        similar attributes, toast and dialog strings). It also checks that
        every `register()` table in `src/ui` has the same keys in `en` and
        `zh-TW`.
      - `tests/i18n-chat-buttons-2390.test.ts`: Discord and Telegram button
        labels written as English literals instead of `t("…")`.
      - `tests/i18n-cli-2390.test.ts`: zh-TW output of the terminal lines it
        covers (restart, start, stop, update, `agend settings`, bug report,
        service repair, doctor service lines).
      - `tests/i18n-web-2390.test.ts`: host refusals and the `/login` page
        that the web shows in the page's language.
      - `tests/dashboard-i18n.test.ts`: the app, chat, fleet and task board
        keys exist in both languages with the same `{n}` placeholders, and
        every `t("…")` call names a registered key.
      - `tests/usage-i18n.test.ts`: key parity for the usage renderers,
        server and View.
      - `tests/delivery-notices-i18n.test.ts`: key and placeholder parity for
        the delivery notices, plus their localized paths.
      - the `changelog` CI job (`scripts/changelog-assemble.mjs --check`):
        every fragment in `changes/` has both halves, and both name the same
        section. `tests/changelog-fragments.test.ts` tests the assembler
        itself.

      These catch missing keys, placeholder drift and English literals in
      the shapes they scan. They do not catch:
      - a zh-TW string that is present but wrong or stale;
      - English built by string concatenation, or in a shape the scans don't
        know;
      - CLI or chat text outside the covered paths;
      - docs, the website and the PowerShell installers.
   2. **Manual pass over the version's PRs.** Every new user-visible string
      has both languages:
      - web UI string tables (`src/ui/*-strings.js`,
        `src/ui/shared/app-i18n.js` and each module's `register()` table),
        and `src/locale.ts`;
      - chat notices (Discord, Telegram, General);
      - CLI and `agend doctor` output;
      - the Windows installer messages (`website/public/install.ps1`,
        `website/public/install-agend.ps1`);
      - the setup and sign-in pages;
      - tips (`src/tips.ts`, `text_en` / `text_zh`).
   3. **Docs and website pairs.** Every `docs/*.md` and website page changed
      in this version has its `.zh-TW.md` or `zh-tw/` counterpart updated
      too. A zh-TW file whose last change is older than its English file's
      is a finding. Check the release notes and what's new in both languages
      as well.
   4. **Findings.** Fix them in the same release, or list them in the release
      issue with an owner.
9. **README.** Update `README.md` and `README.zh-TW.md`: the install command,
   the feature list, screenshots and version mentions.
10. **Website.**
    - Sync `website/src/content` with `docs/`, the install pages
      (`website/src/pages/install-windows.astro` and its `zh-tw` copy), what's
      new, and the version on the home page.
    - The PR is approved with HOLD. The leader releases the HOLD only after
      the npm release (813e85d2); the coordinator then merges it.
11. **Runtime pins.** `publish.yml` runs
    `node scripts/release/check-runtime-pins.mjs <packed .tgz>` before
    `npm publish`. The packed manifest must pin every shipped
    `@songsid/agend-node-<id>` runtime package in `optionalDependencies` at
    one exact version that is already on the registry. If the check fails,
    the publish fails. Run it on `npm pack` output before tagging so it does
    not fail on the tag.
12. **Release.**
    - The user gives an explicit go, as for a beta.
    - The coordinator bumps the version and pushes the tag. `publish.yml`
      publishes the package to `latest`.
    - The leader verifies `latest` on the registry (no-cache, as above) and
      creates a full GitHub release, without `--prerelease`, with the release
      notes as its text.
13. **After.**
    - The leader releases the website PR's HOLD, the coordinator merges it,
      and the leader confirms the **Deploy Website** workflow succeeded.
    - Update the host and check its logs.
    - Close the version's issues.
    - Announce the release.

## Known gaps (as of 2026-10-26)

- `docs/release-notes/` has only 2.2.0 (and 2.2.0-alpha.1). The 2.3.0 and
  2.3.1 notes exist only as GitHub releases.

## Suggested follow-up

A small script for step 8.3: for each English/zh-TW pair under `docs/` and
`website/src/content` (and the `website/src/pages` / `zh-tw/` pages), list the
pairs whose English file changed since the previous `v*` tag while the zh-TW
file's last commit is older than the English one's. Use
`git log -1 --format=%ct <tag>.. -- <file>`. Its output would be the start of
the manual check, not a replacement for it.
