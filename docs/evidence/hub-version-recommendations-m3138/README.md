# M-3138 — version recommendation evidence

Product source: 52e04f663. Plain alpha sync: c15e14aeb (incoming c0c1a63ac); both automatic overlaps preserve the
recommendation delta. No repeated campaign for that sync (decision 5afe2996).

- `baseline-red.log`: the first API journey on phase-1 source 2892cf7c fails semantically because GET returns not-found.
- `final-focused.log`: 16/16 server, Fleet and registry controls. Covers revision/session races, independent npm
  checks, fixed-argv bounds, persistence, stale revisions, replacement link/ACK recovery, follow-Hub restart and retries.
- `link.log`: one owned TLS/WSS packet, 4/4. Current opt-in receiver and both old/new compatibility combinations;
  fixed schemas and 16-name send ceilings. Physical directory and npm are inert. No live Fleet or vendor call.
- `state-web.log`: 2 selected pass (24 deselected): follow-Hub state/retry and admin-only cached update view with arrival
  signal. No updater spawn. The follow-Hub test overlaps final-focused; do not add counts.
- `composition.log`: 223 controls pass, one existing exact migration-list assertion fails on the new member component.
  `migration-pin.log`: that one assertion updated and its full case passes (1 selected, 8 deselected). Nothing else changed.
- Existing protocol + phase-1 tests: 37/37 passed in the adjacent packet; its initial new registry-test failure exposed a
  trailing-newline input edge. Fixed input trimming before the final focused packet (3 registry tests therein pass).
- Source/test TypeScript 6 programs and TypeScript 7 programs: exit 0; empty logs are successful checks.

No screenshots, live npm, AD, account, actual update install or browser campaign. This slice exposes advice; UI and
reminder consumers have their own cards. No sync re-verification. No assertion/timeouts weakened.

Risk: a published release can still be unsuitable; local admin confirmation/install validation remain required.
Ordinary network outage keeps already verified advice. Local connection replacement/disable or policy withdrawal clears it.
Rollback: disable fleet-recommend-v1 or revert product code, retaining the additive advice tables and existing member data.
