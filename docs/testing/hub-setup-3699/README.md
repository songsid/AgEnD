# Hub fixture isolation and setup budgets (#3699)

This is an alpha-only test change. At main `3ab8f3f3f02276a401717482dd4db75df85c7824`,
the Hub composition, company-join test and its fixture are absent. No production code,
guard, workflow, test timeout or retry count changes.

## Two different observations

The failed first attempt of #3697's CI `43078910572`, job `130726714092`, did **not**
time out. The before-publication material-change regression passed its lifecycle
assertions, then `expect(await refused(hub.webPort)).toBe(true)` received false.
The probe interpreted every TCP connect as a listening Hub. Linux can assign the
client's source port to the same ephemeral destination port, making a TCP
self-connection without any listening server. The new real-socket fixture forces
that exact tuple and fails with the old classification; a separate genuine
listener control prevents treating every connect as refusal. The helper now waits
for its client socket to close. The original CI did not record its socket tuple,
so self-connection is a proven probe defect matching that failure, not proof of
that historical occurrence rather than unrelated port reuse.

Ridge's #3660 observation **was** a 10 s timeout in the company-join outer-deadline
case. A quiet, selected-case wall-time profile on alpha `6b66b767` measured:

| Company world phase | ms |
| --- | ---: |
| Fresh rig | 412 |
| Admin sign-in | 140 |
| Group-policy enable | 741 |
| Company-join enable | 100 |

Within the rig, browser certificates took 62 ms, directory certificates 107 ms,
initializer commit 127 ms, and factory creation 82 ms. Compose source certificates
took 46 ms and initializer commit 103 ms. These are single-run wall times, not CPU
attribution or a universal latency claim. They identify world/policy setup as the
largest measured company cost, rather than a dynamic FleetManager import.

## Scope and ownership

- Both suites create immutable source certificate material once in `beforeAll`
  with an explicit 120 s setup budget, and remove it in `afterAll`.
- Company-join creates a **fresh** rig and normal admin/policy setup in `beforeEach`
  with its own explicit 120 s budget. Each assertion body keeps the original 10 s.
  The default-off case opts out of policy enable through task metadata.
- Every case still owns fresh keys, sealed initialization, home, SQLite database,
  directory peer, users, sessions, group policy, listeners and real HTTP operations.
  Fake time begins in the test body after setup, as before.
- The optional source certificate bundle has a checked hostname and caller-owned
  lifetime. Other users of the fixture still create and clean their own bundle.
  The tests pin hostname refusal before listener creation and source survival
  after closing each rig. Rotation tests write only their own initialized homes.
- The compose suite keeps real initializer and mutable per-case setup in its
  original callers. Its non-Hub tests do not initialize an unnecessary Hub.

## Reproduce the bounded pressure comparison

Use an existing local `node:22-bookworm` image, compatible Node 22 dependencies,
and Docker. The runner never pulls an image, uses no network, and runs one selected
case in one non-privileged container capped at 0.2 CPU/768 MiB/128 PIDs. One busy loop
shares that same CPU quota. Nothing runs on a real fleet or account. The finally
block removes only its uniquely named owned container. Scratch output is retained.

```sh
git show 6b66b767ba1f401ebe5d92e458c73ec22d2a1fa7:tests/hub-company-join-http.test.ts > /tmp/hub-company-baseline.ts
python3 scripts/manual/hub-setup-3699/pressure.py --out /tmp/hub-3699-before --test-source /tmp/hub-company-baseline.ts
python3 scripts/manual/hub-setup-3699/pressure.py --out /tmp/hub-3699-after
```

Run the two commands serially. The baseline override uses the helper's unchanged
fresh-material default path; the fixed suite explicitly supplies its shared
source bundle. No blanket per-test increase, sleep, fake product answer or retry
is used. See `results.md` for this run's exact outcomes and limitations.

## Routine validation

```sh
node node_modules/vitest/vitest.mjs run tests/hub-compose.test.ts --maxWorkers=1
node node_modules/vitest/vitest.mjs run tests/hub-company-join-http.test.ts --maxWorkers=1
node node_modules/@typescript/native/bin/tsc --noEmit -p tsconfig.test.json
git diff --check
```

Revert the test commit to roll back. This changes test-fixture ownership and probe
classification only; it does not alter a shipped Hub's listener lifecycle.
