# M-3160: Hub-question contact limit

> **Screenshot privacy refresh (M-3513, 2026-11-22):** 1 affected paths recaptured, 0 historical dialog details cropped, 0 unreproduced pictures withdrawn. Current rendering only; prior source/test receipts remain historical. Static captures do not establish offscreen reachability or provider/native operation. See [privacy-refresh-m3513.json](privacy-refresh-m3513.json) for each disposition/source/hash. No live provider, CLI, pane or Fleet was used.

Root cause: Hub questions use a shared agent's ordinary conversation and outbound tools. Those handlers had no question-scoped contact check; a Hub asker could prompt the agent to reach its Fleet peers.

The send handler now checks the calling instance's durable windows before ordinary contact admission; delegate/request/report wrappers share that path. Broadcast checks before any target is admitted. Only a claimed Hub answer is exempt, not an ordinary instance merely called `agend-hub`. The per-share choice defaults on; direct and room asks carry it to the same Fleet input hook. Windows persist before possible IPC exposure, overlap independently, expire after 30 minutes, and close on successful answer. Lumen confirmed that bounded duration. Invalid answers/uncertain input do not unlock the agent. No live agent was used.

Settings adds the default-on tick, confirmation summary and one-time acknowledgement of the notice for old shares, retained by materializing the already-effective default in the existing local descriptor (with an audit event). No new database schema or Hub protocol field. Room journals keep their existing shape. Skills and the design note state the limitations honestly.

Fail-first: at base `93c6e9fb7`, the five initial peer-contact/broadcast refusal cases in `hub-contact-limit-3160` failed before the guard existed. The stopped-target fixture control was corrected separately. Final focused runs include positive ordinary-contact and Hub-answer controls, persisted restart/overlap/expiry, invalid answer, old-share default/notice and explicit opt-out.

Validation: broader focused run **231/231**; final affected room/contact run **60/60** and policy/UI run **39/39** after the last edits. Both production and test typechecks pass. Browser checks pass for both captured cases.

Commands:

```sh
npm run typecheck
npm run typecheck:tests
npx vitest run tests/hub-contact-limit-3160.test.ts tests/hub-exposure-api-s3c.test.ts tests/hub-ui-s3c.test.ts tests/hub-representative-fleet.test.ts tests/hub-room-ask-track-c.test.ts tests/hub-exposures-s3c.test.ts tests/hub-compose-member.test.ts tests/outbound-fire-and-queue.test.ts tests/tool-permissions.test.ts --maxWorkers=2
REPO="$PWD" PW_DIR="$PWD/node_modules" OUT="$PWD/docs/evidence/hub-contact-3160" npx tsx scripts/manual/smoke/smoke-hub-contact-3160.mts
```

The PNGs use the real product shell/card/CSS with an inert member client and mocked membership projection in a scratch FleetManager. They cover desktop/light/English and phone/dark/zh-TW, default-on, notice dismissal and explicit opt-out. `checks.json` records zero page errors. Two images were visually inspected: no clipping or overlap. No vendor CLI, tmux session or real Fleet was started. Initial harness attempts failed because the new connection card requires the versioned membership projection; those attempts produced no accepted screenshots.

Risk: unrelated owner work contacting peers must retry after the Hub answer; after 30 minutes the limit ends even if the question is still being answered. Own tools/files, earlier knowledge and room posting are outside the limit. Unreadable window state refuses contact until repaired. Policy changes follow existing sharing revision semantics. Rollback is a coordinator revert; optional policy fields and the separate windows file are inert for older Fleet contact handlers, and no room-journal/schema migration is needed. A rollback removes this restriction; retain that risk when deciding to revert.

## Review/CI correction

R1 keeps an older store's absent notice method compatible, pins the added translated contact-summary row, and narrows older sharing-toggle selectors to the main switch (all prior counts/disabled-state assertions remain). The standalone window helper lives in the Fleet layer rather than importing a Hub module eagerly. Focused checks: the two initially reported files pass 15/15; the later shard-1 hooks/UI/contact files pass 48/48. No PNG or broad-suite rerun for these scoped changes.

Fable's non-blocking design note remains explicit: unreadable window storage currently refuses peer contact across the Fleet, even for agents that never receive Hub questions. A narrower failure policy is deferred; the tested fail-closed rule is unchanged here.
