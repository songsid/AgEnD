# M-3160: Hub-question contact limit

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
