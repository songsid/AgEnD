# CI coverage and scheduling

[繁體中文](ci.zh-TW.md)

## Routine checks

The regular `ci.yml` and `npm-rollback-proof.yml` jobs use Linux runners on
PRs and branch pushes. Their macOS install jobs run on release tags, manual
runs and a weekly schedule. Routine runs therefore create no Mac cells;
the test steps and supported Node/npm versions stay the same.

| Workflow | PR / branch push | `v*` tag / manual / weekly |
| --- | --- | --- |
| `ci.yml` install smoke | Ubuntu × Node 22.14.0, 22, 24, 26 | Same Ubuntu cells + macOS × all four Node versions |
| `npm-rollback-proof.yml` | Ubuntu × npm 9.9.4, 10.8.2, 11.6.2 (Node 20.19.0); PR path filter retained | Same Ubuntu cells + macOS × all three npm versions |
| `data-downgrade.yml` | Ubuntu current → published 2.1.12 → current, and current → published 2.2.6 (on its own bundled Node 22) → current | No extra trigger; Linux-only |

The CI workflow still runs CHANGELOG guards, the GitHub Actions SHA-pin guard,
typecheck/build, four unit shards, integration tests and the Node 20 preinstall
rollback smoke. On a pull request, `detect-changes` classifies the diff against
the merge-base (`scripts/ci/detect-changes.sh`) and skips the heavy steps the
change cannot affect. The jobs themselves always run and report success, so the
merge gate never sees `skipped` (a job-level skip on a matrix cell would leave
that required name pending). An unreadable or empty diff, and every non-PR
event (push to main, tags, schedule, `workflow_dispatch`), run the full suite
(fail closed). CodeQL is unchanged (GitHub default setup).

- **text-only** — only `docs/**`, `changes/**`, root `*.md`, and
  `website/src/content/**`. CHANGELOG guards, the pin guard, Gitleaks, and the
  tests in `scripts/ci/docs-reading-tests.txt` run. The four shards,
  integration, typecheck/build and install-smoke skip their heavy steps. A
  test that reads `docs/`, a root README, or website content pages and is
  missing from that list fails `tests/docs-reading-tests-list.test.ts`. Any
  `src/`, `tests/`, `scripts/`, workflow, package or lockfile path means it is
  not text-only.
- **packaging** — `package.json`, a lockfile, `launcher/`,
  install/update/service code and scripts, any `scripts/**` path, and any
  `.github/**` path. `install-smoke` and the Node 20 rollback smoke run their
  real steps.
- **deps** — `package.json` or a lockfile (root or `website/`), or any
  `.github/**` path. `npm-audit-signatures` and `dependency-review` run their
  real step.
- **src** — any `src/**`, `scripts/**`, or `.github/**` path.
  `data-downgrade` runs its real step.

A change to a gated job's own workflow, action or scripts turns that job on:
`.github/**` runs the full suite (packaging, deps and src true, text-only
false). `scripts/**` sets src and packaging.

macOS is included on all `v*` tags, including prereleases.
Weekly CI runs Monday at 03:17 UTC; the npm proof runs at 03:37 UTC. Weekly
failures need investigation but are not a prerequisite for a PR or branch push.

Runtime acceptance and runtime publishing are separate workflows; their
coverage is defined there. See the [private runtime design](design/1450-private-node-runtime.md).

## Superseded runs and the merge gate

CI, Gitleaks, data-downgrade and npm-rollback-proof use a workflow + PR-number
concurrency group. A newer PR head cancels the old run, releasing its runners.
Branch pushes, tags and scheduled/manual runs are retained.

The merge gate requires successful checks on the exact head. It also checks
every other check-run present on that head, so `skipped` is not accepted.
The OS matrix therefore creates only Linux cells on routine events: optional
Mac check-runs are absent, rather than created and skipped. The required
`build` aggregate always exists and still rejects a failed, cancelled, skipped
or missing Linux smoke result. Required-check absence remains an error.

Runner queue delays vary with GitHub capacity. Moving Mac jobs out of routine
runs reduces that dependency; it is not a fixed wall-clock completion guarantee.

## The published 2.1.12 comes from a cached tarball

The Node 20 rollback smoke, `data-downgrade.yml`, the runtime-acceptance hop and the Mac GUI rehearsal all install
the published `@songsid/agend@2.1.12`. Each registry fetch of that tarball counts as an npm download, so CI fetches it
once and keeps it in the Actions cache (`.github/actions/published-agend-tarball`, key `agend-tarball-2.1.12-v1`):

- Before every use, the tarball's sha512 must equal the registry's `dist.integrity` (`npm view`, a metadata request,
  not a download). A mismatch fails the job; nothing re-fetches around it. A freshly fetched tarball is cached only
  after it passes.
- `scripts/ci/install-published-tarball.sh` installs it with npm's http log on and fails if npm fetched an
  `@songsid/agend` tarball anyway. Dependencies still come from the registry.
- On a cache hit, the action's log says `cache hit (agend-tarball-2.1.12-v1): no registry download of
  @songsid/agend`, and the install reports how many dependency requests it made, none for our tarball.

A new pull request restores the entry its base branch saved. To drop it on purpose, bump the key's `-v1`.

### Rehearsals

A release rehearsal that installs a published version in several legs packs it once and reuses the file, rather than
installing it by name in each leg:

```sh
mkdir -p ~/.cache/agend-published && cd ~/.cache/agend-published
npm pack @songsid/agend@2.1.12      # once: the only download
bash <checkout>/scripts/ci/verify-published-tarball.sh ~/.cache/agend-published/songsid-agend-2.1.12.tgz @songsid/agend 2.1.12
# each leg:
npm install -g --prefix "$PREFIX" ~/.cache/agend-published/songsid-agend-2.1.12.tgz
```

A rehearsal of a change to the upgrade path runs these legs. Each one starts from the published 2.1.12 and from the previous beta, and goes to the packed candidate:

- **L**: a user unit, with a user bus.
- **N**: a user unit with no user bus. The update goes through the peer client on `systemd/private`.
- **S**: a system unit (`/etc/systemd/system/agend.service`) for a root fleet. From 2.1.12, the refresh has to bring its `ExecStart` to the candidate (#1884).
- **D**: a detached fleet with no service.
- **Mac**: launchd, with the update run from an agent's session, from an operator's terminal, and through `/update`.

Each leg records the fleet's pid and program before and after the update.

## GitHub Actions pins (#2528)

Every remote `uses:` in `.github/workflows` and `.github/actions` is a
40-character commit SHA, with the version tag in a trailing comment:

```yaml
- uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0
```

A local composite stays `./.github/actions/…`; its own remote `uses:` are
pinned too. A floating tag (`@v4`, `@v4.4.0`, `@main`) or a short SHA fails
the `actions-pinned` job in `ci.yml`: that job runs `npm ci --ignore-scripts`
then `scripts/ci/assert-actions-pinned.mjs` on every event, including a
text-only PR. The guard parses YAML with the lockfile's `js-yaml@4.3.2`.
The `build` aggregate fails unless that job is `success`.

### How pins are updated

Dependabot's `github-actions` ecosystem (`.github/dependabot.yml`, weekly,
`directory: /`) rewrites the commit SHA and the trailing tag comment
together. Patch and minor version-updates share one PR
(`github-actions-patch-minor`); security updates of those same levels share
another (`github-actions-security-patch-minor`). Each major is its own PR
so a Node-runtime or artifact-protocol bump is reviewed alone. Majors are
not ignored: Node 20 actions stop on GitHub-hosted runners after 2026-09-16.

Review a Dependabot pin PR by resolving the tag to a SHA
(`gh api repos/<owner>/<repo>/commits/<tag> --jq .sha`; peel an annotated
tag through `git/ref/tags` then `git/tags`) and checking it matches the
`uses:` line. Do not guess the SHA or hand-edit it without that lookup.
Review a third-party action at the pinned commit; the only one today is
`gitleaks/gitleaks-action` (commercial licence, `dist/index.js` at
`e0c47f4f8be36e29cdc102c57e68cb5cbf0e8d1e` / v3.0.0).

To add an action by hand, use the same lookup, write the 40-character SHA
and the tag comment, and leave the pin guard green.

### Publish workflows

`publish.yml` publishes `@songsid/agend` only on a `v*` tag push.
`workflow_dispatch` is validation-only: checkout, `npm ci`, typecheck and
build; it never runs `npm publish`. `publish-runtime.yml` defaults
`dry_run: true` and runs `npm publish --dry-run`. Leave `dry_run` true except
for a real runtime-package publish.

## npm registry signatures (#2528)

`npm-audit-signatures.yml` runs `npm audit signatures --json` on the root tree
and on `website/` after `npm ci --ignore-scripts`. Invalid signatures, invalid
attestations, mixed findings, and command or parse failures fail the job.
Missing-only findings are printed and do not fail (npm 10 itself exits 1 for
missing as well as invalid; the wrapper applies that report-only policy).
On a pull request the real `npm ci` and `npm audit signatures` steps run only
when the diff sets `deps` (`package.json`, a lockfile, or any `.github/**`
path); otherwise the job still reports success. Push to main always runs them. The job does not run
package lifecycle scripts: `esbuild` / `lightningcss` postinstall and any
native `install` (for example `better-sqlite3` in the test jobs) stay in
`ci.yml` and `deploy-website.yml`, which still run a full `npm ci`.

## Dependency review on PRs (#2528)

`dependency-review.yml` runs `actions/dependency-review-action` on pull
requests into `main` and `release/**`. The action itself runs only when the
diff sets `deps` (`package.json`, a lockfile, or any `.github/**` path);
otherwise the job still reports success. GitHub diffs the PR against its base; this is not a
full-tree audit of `main`. Config: `.github/dependency-review-config.yml`.

The check **fails** the PR when any of these appear in that diff:

- a **high or critical** advisory (`fail-on-severity: high`) in a
  `runtime` or `development` scope (`fail-on-scopes`);
- a newly introduced **licence** that is not on the allow-list (the
  licences in the root and website trees today: 0BSD, Apache-2.0 and the
  one Apache-2.0/LGPL/MIT conjunction, BSD-2-Clause, BSD-3-Clause,
  BlueOak-1.0.0, CC0-1.0, ISC, LGPL-2.1-or-later, LGPL-3.0-or-later, MIT,
  MPL-2.0, Python-2.0).

It does **not** fail on moderate/low advisories, on an undetectable
licence (those are reported), or on an advisory that already exists on
the base branch and this PR does not change.
