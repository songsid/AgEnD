# S214: footprint headings and explicit sample limits

This is the Leader-requested tiny follow-up after #4321 merged and all four post-merge workflows passed. Base is the actual dev tip `9e922bbeff05f43d11cfdb3727fa37ab6df0d447`. It changes only three production presentation files: the zh-TW managed-files heading becomes 「管理檔案」 and stays on one line; its shared row becomes 「共用服務」 to avoid introducing an orphan character; both Settings hints name the 128-agent / 4096-whole-computer-process limits and explain that a sample is unavailable above either limit.

There is no collector, sampler, policy, history, schema, API or configuration change. The process cap is for the computer's whole process inventory, not 4096 per agent, not a quota on CPU or memory, and not the 50-row display page size. Existing cost, known-file-only and no-workspace-scan disclosures remain.

## Validation

- Two locale cases tied to the actual `FOOTPRINT_ROOTS` and `FOOTPRINT_ROWS` constants fail before the hint correction: [fail-first log](before-tests.log). Afterward, Settings + footprint UI pass **23 tests / 2 files**. The final table-label delta is rechecked in **6/1** (overlap, not added twice). [Phone/shared-query checks](phone-css.log) pass **3/1**: **26 distinct tests across three files**.
- [Production build](build.log), [final asset generation](final-assets.log), and [test TypeScript check](test-types.log) exit zero. No broad suite or new one-hour measurement; no account or model call.
- The real-browser range geometry reproduces the original header at **two lines**, then proves the final heading at **one line**. Shortening alone still wrapped; a scoped header `white-space: nowrap` fixes it. Both before and final after views have no page/table overflow; phone controls meet 44px targets. The subsequent short shared label removes the new orphan character. Other views are unchanged.
- [Source input hashes](source-inputs.json), [before response bindings](before-inputs.json), [after response bindings](after-inputs.json), and [manifest](manifest.json) bind the source and images. The final table retake has its own current asset hashes; the Settings images remain bound to their earlier, unaffected inputs.

## Real-app images

[Gallery](gallery.md): desktop/light/EN Settings, phone/dark/zh-TW table and Settings, each before/after. All six current originals were visually inspected and are privacy clean. The same completed S209 numerical host cache and history are reused with synthetic helper/volume aliases, original sample times and honest stale labels. This is not another native-hour measurement, a live Fleet workload, or a claim that the scratch helper is still running. No raw snapshots, process IDs, real disk identities, company data or `-t` names are published.

`capture-copy.mts` under `scripts/manual/host-footprint` boots the normal real-app fixture and reads the completed private cache. It starts no monitoring collector, Fleet, CLI, tmux, account, model or notification sender. Example:

```sh
PHASE=before OUT=/work/evidence/before MEASUREMENT=/work/private/completed-hour.json \
REPO=/work/agend PW_DIR=/work/agend/node_modules CHROME=/path/to/chrome \
node --import tsx scripts/manual/host-footprint/capture-copy.mts
# Apply the copy changes, then use PHASE=after and a new OUT.
```

This is a normal small follow-up gate, as requested after the feature's visual release; the feature PR is already merged. Prism reviews; coordinator alone merges after exact approval and green CI. Completion still requires actual merge/ancestry and green post-merge workflows. Rollback is a revert of these presentation changes; saved settings, limits and data are unaffected.
