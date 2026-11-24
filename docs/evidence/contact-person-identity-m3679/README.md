# Contact identity across bot connections

Author execution evidence. Synthetic people, bot connections and SQLite stores;
no live Fleet, real account, provider, browser or model call.

A person observed by two bots on the same platform was counted twice. A known
origin became mixed, and the contact-admin check also required the delivering
adapter to match. The fix uses platform + user id for contact identity and
configured contact-admin eligibility on the target platform. Routing and human
receipt proof fields retain their actual bot context.

The initial six regression cases fail on base `c0cb46de3` and pass with the fix.
The final 14 affected suites pass 271 tests at `1fbbe66f4`; source and test
TypeScript checks pass. `verification.json` lists the exact files and reversals.
For the suite command, run `npx vitest run` with each listed name prefixed by
`tests/` and suffixed by `.test.ts`, with `--maxWorkers=1`. Type checks:
`npm run typecheck` and `npm run typecheck:tests`.

Six reversals each cause semantic test failures: adapter-based identity keys,
raw historical-origin reads, adapter-based admin matching, losing the platform
boundary for admin roles, clearing unknown origins, and bypassing an old pending
operation after recovery. All mutations were restored before the final run.

Controls retain different-user/platform separation, the distinct-person cap,
explicit unknown and mixed singleton restrictions, target configured approvers,
source/target generations, grant scope/expiry/uses, old selector compatibility,
and pending-ticket decisions. The real inbound and outbound methods prove that
reply, edit and reaction still use the topic's configured bot when a sibling bot
observed the incoming message first. Human receipts keep that observing bot.

A normal merge onto `a12b8fe32` preserves all 15 owned ordered added/removed-line
sequences exactly, with no extra product paths. Integration verification is
recorded separately after that merge. There is no migration or manual state-file
edit. Reverting restores adapter-specific interpretation and may restore those
contact restrictions; old pending tickets are never automatically dispatched.
