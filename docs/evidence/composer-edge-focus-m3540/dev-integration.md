# Standalone dev twin

Main #4357 actually merged as `398660ab7ad1e9263be308fb36188ae18d4450b4` at 2026-11-23T08:26:43Z. Fetched main ancestry and all 19 approved blobs were verified before creating this branch from fresh alpha `a1a059f819e47f73a07aae48a198e2eb0b203bf8`. All five main post-merge workflows succeeded, including CI45138667145.

The focus helper and the three selection/gutter rules are byte-identical to approved main. Dev retains its canonical phone/short-landscape full-width query, shared ComposerInput, workspace refs/ids, native feature controls, phone meta line and subagent progress. Its shared ComposerInput owns the inner padding handler; Fleet Dock owns only its own work/meta-to-status strip. No global textarea lookup or pointer listener was added. The Hub's shared row keeps its own textarea ref; its auth/store paths are unchanged.

Fresh dev composer/authorization suites initially passed 34/34 before adding two integration controls. The new shared two-field isolation test passes and preserves the other pane's draft. The phone-meta suite passes 7/7, including the new strip/Stop action test. A first new phone test reused an instance with an intentionally unresolved earlier cancel, so it was isolated under its own synthetic name; existing fixtures retain their defaults. These bounded runs clear 42 distinct cases; repeated/overlapping checks are not additional cases. Test typecheck: zero errors. No production adjustment was needed for the fixture isolation.

The historical main captures, browser records and main source-hash files are copied byte-for-byte and retain their original scope. The user explicitly waived another screenshot round for the expanded strip. No new dev browser, screenshots, provider, native device, live Fleet or pane campaign was run. `dev-verification.json` records the current integration hashes; earlier manifests describe their named historical main source, not the dev layout.

Source review and exact-head CI are still required. Coordinator alone gates. Rollback reverts the helper/wiring/selection/gutter styles; no stored data or migration is involved.
