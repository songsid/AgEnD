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
| `data-downgrade.yml` | Ubuntu current → published 2.1.12 → current | No extra trigger; Linux-only |

The CI workflow still runs CHANGELOG guards, typecheck/build, four unit shards,
integration tests and the Node 20 preinstall rollback smoke. Existing docs-only
step guards remain. macOS is included on all `v*` tags, including prereleases.
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
