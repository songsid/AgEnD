# Contact identity across bot connections

Author execution evidence. Synthetic people, bot connections and SQLite stores;
no live Fleet, real account, provider, browser or model call.

A person observed by two bots on the same platform was counted twice. A known
origin became mixed, and the contact-admin check also required the delivering
adapter to match. The fix uses platform + user id for contact identity and
configured contact-admin eligibility on the target platform. Routing and human
receipt proof fields retain their actual bot context.

The initial six regression cases fail on base `c0cb46de3` and pass with the fix.
`base-repro.test.ts.fixture` retains those controls: copy it into `tests/` with a
`.test.ts` suffix in an owned checkout of that base and run it with Vitest.
The final 16 affected suites pass 344 tests at `7984d8fbc`; source and test
TypeScript checks pass. `verification.json` lists the exact files and reversals.
For the suite command, run `npx vitest run` with each listed name prefixed by
`tests/` and suffixed by `.test.ts`, with `--maxWorkers=1`. Type checks:
`npm run typecheck` and `npm run typecheck:tests`.

Seven reversals each cause semantic test failures: adapter-based identity keys,
raw historical-origin reads, adapter-based admin matching, losing the platform
boundary for admin roles, clearing unknown origins, bypassing an old pending
operation after recovery, and allowing a newly matching grant to release that
old pending operation. All mutations were restored before the final run.

Controls retain different-user/platform separation, the distinct-person cap,
explicit unknown and mixed singleton restrictions, target configured approvers,
source/target generations, grant scope/expiry/uses, old selector compatibility,
and pending-ticket decisions. The real inbound and outbound methods prove that
reply, edit and reaction still use the topic's configured bot when a sibling bot
observed the incoming message first. Human receipts keep that observing bot.

A normal merge onto `2698b1302` (including the Hub answer-turn fix) preserves all
18 owned ordered added/removed-line sequences exactly, with no extra paths. The
merged integration check passes 90 tests in six suites plus source TypeScript. There is no migration or manual state-file
edit. Reverting restores adapter-specific interpretation and may restore those
contact restrictions; old pending tickets are never automatically dispatched.

Review correction restores current-role checks through the central Fleet-admin
gate instead of treating the picker inventory as authorization. Five gate and
notification regression cases fail before this correction. A separate conflicting
retry assertion also fails before moving the immutable request-hash check ahead
of the pending-decision response. The full contact and affected-suite union now
passes 451 tests in 29 files; both TypeScript checks pass. The file list is in
`reviewCorrection.testFiles`. Old pending operations remain held even with a
newly matching grant; conflicting payloads return `operation-conflict`.

Configured same-platform contact administrators are intentional. Runtime-only
or removed worlds do not add eligible connections. The pre-existing Classic
room `defaults.admin_users` fallback is unchanged. No browser, provider, native
CLI or live-state campaign was repeated for this correction.
