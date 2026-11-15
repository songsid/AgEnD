# Native Codex readiness and hand-off acceptance (#4019 / M-3200)

Source PR: #4021, `e6b17ab25babd68e03d44a256d7576c97b8c235f`.
Runtime source is unchanged from Fable's source-cleared `c6c0efcba`.

Interrupting a queued Codex turn restores a wrapped composer draft. The shared detector accepted only one physical prompt row, so Linux/tmux and native Windows both kept the execution state working and never began the hand-off idle timer. The shared detector now recognizes that captured draft, while a separate state-only proof keeps the empty-input contract for pause and capacity nudges. A subsequent delivery neither clears nor submits a restored human envelope, and final baseline/native screen checks refuse an occupied composer before writing.

An owned Windows resume can show an empty composer without its normal footer. Recognition is restricted to Windows ConPTY, the owned contextless resume and context-only status configuration. It requires the captured interrupted prefix or a captured `/status` metadata block bound to the expected session UUID. Unknown menus, wrong or duplicate UUIDs, drafts and running turns remain held. General passive-footer grammar, expected-sequence admission and one-shot status checks are retained.

## Checks

- Captured state and lifecycle failures were red before the implementation.
- Eight affected test files: 273 passed; source and test TypeScript programs: exit 0.
- Generated detector manifest: 87 passed.
- Additional structured safety-sweep regression: passed. Reverting its state-only proof call makes it assertion-red (`working` instead of `idle`), then source was restored.
- Native pause, late bot envelope and human draft controls fail when their guards are removed. Existing malformed-menu, pause and capacity-nudge tests remain unchanged.
- Exact-head CI receipt is linked from the PR acceptance comment.

## Final native acceptance

Only M-3133 legs 5 and 7 are retaken. Earlier queue/taken and same-launch replacement evidence remains at `0d3725388a51ec2530412514bad5dc83f72ae71d` under `docs/evidence/native-queued-handoff-m3133/fixed-alpha`.

Final results and original chat/Notices PNGs are under `final-e6b17ab25/`. The isolated harness uses the real FleetManager, Daemon, Windows host, signed-in Codex 0.165.0 and pinned launch flags. Each prompt is one line. The real input ACK and visible native queue are required before either leg begins. Transcript watches, wall clock, notices and persisted hand-off records are production code. Coordinator tmux/provider fallback and unrelated outbound actions throw. The user's running Fleet and panes are not used.

- Leg 5: a real queued runtime hand-off was interrupted. Execution stayed idle with the human draft retained and pause refused; one not-taken notice arrived after the real 90-second idle observation (112 seconds including batching). No confirmation or canary reply. Original payload applied once.
- Leg 7: the original launch exited; a new owned launch resumed the same session without the old 120-second stall. The old hand-off settled unverifiable once. A second coordinator replacement did not repeat the notice or paste the payload again. Original payload applied once.

The worker bundle has the same hash as earlier builds because these readiness changes run in the coordinator. `coordinator-receipt.json` separately records the compiled Daemon/detector/lifecycle hashes. `harness-receipt.json` freezes the helpers before launch.

## Scope and cleanup

Earlier fc17 validations have their own exact source scope in `native-validation-fc17/`; they are not the final release proof. Five earlier owned scopes are separately accounted for in the cleanup ledger, including two excluded preparations (unproven queue admission and a harness precondition error). All were closed, exactly archived where materialized, checked for zero owned processes and removed. No later result is claimed for those heads.

The final cases each include positive pane/host closure, official archival of only their exact session UUIDs, zero remaining owned processes, browser closure and scratch removal. No alternate Codex home, credential copy, user settings change, restored-text clearing or auto-send was used. Account/path display fields are masked in JSON; PNGs are copied unchanged. Auth/session-code files and raw provider captures are excluded.

Unknown future layouts remain held. A restored human draft may keep new delivery waiting until the person acts or the outbox expires. Rollback reverts this code; it does not migrate or erase queued hand-off records or text.
