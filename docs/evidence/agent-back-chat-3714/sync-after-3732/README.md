# Plain sync after parent #3732

Source merge `c578e251cda8e60292de800ae65aa6c332d31947` has parents approved R4 `efbe521656b87dc1b4c47f57eb679aae09be0069` and alpha `24601fe2db169a2b92d560bb573317bfddb1fa0d` (merged #3732). No rebase or force-push.

Git reported conflicts in `chat-workspace.js` and its entry test. This child had no changes in either file relative to its original #3732 parent; both resolved files are byte-exact copies of merged alpha. The annotation target's raw identity, display label, commit/live fences and existing tests are retained. No new manual behavior is introduced.

[Source audit](source.json):197 incoming paths outside overlaps exactly match alpha. The net production delta is still the four approved R4 UI files. `panel-details.js`, `agent-details-settings.js` and `instance-nav.js` are byte-exact approved R4 blobs. The complete added Settings CSS block is unchanged. Automatic CSS merge retains all incoming styles. Pane/popup headers and annotation behavior match alpha.

[113/113 across eight focused suites](focused.log) pass with one worker, including Settings return, sidebar rules, common controls, menus and annotation quote+attachment controls. [Native source](source-types.log) and [test types](test-types.log) pass. No browser run occurred for this sync; the accepted R4 phone/desktop gallery retains its original capture source and receipts. The resolved source adds no new visible presentation at the merge seam. No new whole-alpha/browser claim is made.

Owner PNG OK is received. Fresh exact-head Fable and required CI remain necessary; coordinator owns merge, with queue order #3726 → #3706 → #3740. Recheck moved alpha for overlap before gating. M-2959 confirms only parent24601fe2's post-merge green. No live fleet/account/CLI/AD/pilot operation; rollback is a normal UI revert without migration.
