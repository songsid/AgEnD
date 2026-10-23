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

The CI workflow still runs CHANGELOG guards, typecheck/build, four unit shards,
integration tests and the Node 20 preinstall rollback smoke. Only a PR that
changes nothing but `changes/` fragments skips typecheck/build and the tests (the
CHANGELOG guards still check it); a change under `docs/` or to a root `*.md` runs
everything, because tests read those files (#1932). macOS is included on all `v*` tags, including prereleases.
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
