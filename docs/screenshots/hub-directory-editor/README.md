# AD connection editor evidence

Current R1 evidence (leader UI polish plus Fable’s two display-guard regressions):

- `after/`: the fresh full desktop/phone × light/dark × EN/zh-TW matrix on both real shells, recorded by `matrix-r1.json`. Each surface has form, trust-source, lower-action and native trust dialog. Host Run/retention/company cards have separate settled viewport captures, with full retention controls above phone navigation.
- `before/`: the same eight cases on actual pre-editor server/UI `31a973af`, without API or module replacement (`before-first.json` plus `before-remaining.json`).
- `recovery/` with `recovery-r1.json`: old AD down, anonymous CA refusal/service-only pinned retry, complete SHA-256 groups and saved off-state. The receipt also covers the actual local Run switch stopping while AD is down, Test/Save while off, and Run again.
- The three `skew-*-r1.json` receipts freshly check retained modules, retained host HTML, and an actual earlier server with candidate static modules. Old-shell keeps a current Hub positive control. No API replies are stubbed.
- `checks-r1.json` records the restored related suites, types and both full UI gates. `mutations-r1.json` records a fresh complete 28-guard pass, including the new-panel/old-client and gateway-shell checks requested by Fable.

R0 receipts (`checks.json`, `mutations.json`, `matrix-original.json`, `phone-english-final.json`, and un-suffixed recovery/SKEW receipts) retain their original scope at `bc10ddfed`. The original mutation receipt combines25 first-pass reversals plus its targeted lifetime rerun; it is superseded for the current source by the fresh28 in R1. To view the old PNGs, use that commit; `after/` and `recovery/` now hold current captures. The earlier isolated local compose timeout is disclosed in `checks.json` without a confirmed-flake claim.

The browser rig and copyable recipe are in `scripts/manual/hub-directory-editor/`. Every run closes its own browser, listeners, controller/runtime and scratch home. No real directory, account, pilot, live fleet, CLI, native service or production deployment was used. Passwords are dummy fixture inputs; screenshots show them only empty or masked. Public endpoints are generated loopback fixtures.
