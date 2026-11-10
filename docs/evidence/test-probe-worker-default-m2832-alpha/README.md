# M-2832 alpha twin

Main landed first: [#3583](https://github.com/songsid/AgEnD/pull/3583), squash `3ec84c79a6c486efdbd41400b50e19c36e2f2491`. The shared setup, selective constructor, fake helper, default-boundary tests and both changelog files here match that source byte-for-byte (`receipt.json`). Main's historical fail-first, nine reversals and focused/inert-native controls retain their [original main scope](https://github.com/songsid/AgEnD/tree/42c0d12139a8be617e79939ffd35c2955ab4fca8/docs/evidence/test-probe-worker-default-m2832); they are not new alpha executions.

Alpha removes **14** blanket mocks: the 12 shared suites present here, plus `accounts-settings-3212` and `accounts-confirmation-3335` from M-2814. Their custom answers, stop cleanup and all original assertions stay. Main's `tmux-startup-refusal-3437` suite is not on this alpha base and is not introduced. All three intentional custom entry/Kiro Worker mocks remain. Only the shared setup entry is added to each config; alpha's extra `pane-port-native-2950` integration entry, budgets, guard, other Worker types and product tree remain intact.

The alpha lexical inventory has 97 save references, 26 call-shaped files (24 without old Worker mocks), ten bounded-probe references and 17 old Worker mocks. These counts include fixture/refusal text; they are not a dynamic call graph. `node docs/evidence/test-probe-worker-default-m2832-alpha/inventory.mjs` reproduces the recorded base snapshot.

Fresh alpha checks:

- **412/412** across 24 probe/account/guard/config/changelog files at the committed source in `receipt.json`.
- **517/517** across all 26 save-call-shaped files.
- **4/4** in the serial integration probe suite.
- Test typecheck and diff checks pass. Six parity files, product tree and three guard files verified.

The groups overlap. Native Workers only execute private inert bodies and the deliberate guard-refused dummy fixture; no real model CLI, account or live fleet is exercised.

The initial 24-file run was **411 passed / one timeout** at the first fresh-cache case in `model-stale-refresh`. That fixture imported `FleetManager` inside the first test body. The import now runs at collection time, preserving every assertion and the original 10-second deadline. The affected four-file follow-up passed 43/43; the final committed-source 24-file run passed 412/412. This records the failed execution rather than replacing or relabelling it, and claims no retry/timeout increase or general flake fix.

This is test-only. A test expecting model discovery supplies fake answers or explicitly uses the guarded native opt-in. Roll back by reverting the test harness/config changes; runtime data is untouched. Full alpha CI and parity approval remain the merge gate; coordinator alone merges.
