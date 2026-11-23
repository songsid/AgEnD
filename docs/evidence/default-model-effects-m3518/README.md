Shared backend/model defaults

The old loader merged the Fleet backend and model independently. An agent selecting another backend still inherited the Fleet model. The resolver and dev Settings counter repeated this fallback; model/backend differences then used the generic cold stop/start reconcile.

The fix scopes a model to its exact declaring backend, preserves explicit agent models, and applies the same rule to ClassicBot's room → Classic defaults → Fleet defaults chain. Changing the shared backend clears its prior model selection. Counts use matching-backend consumers; previews also include model inheritance gained/lost when a default backend changes.

Before Save, choose **Next restart · no restart now** (the safe default) or **Restart running agents now** (confirmed before the first write). This shared path offers next-start adoption rather than calling individual model switching, which writes own overrides and may restart on an unconfirmed CLI result. Deferred identities survive unrelated reloads without hiding other cold changes. Restart consent is bound to the current saved value/runtime owner. Stopped and paused agents stay stopped. Runtime-facing model/backend readouts and command dispatch keep the old identity until the next start. Other edits retain their own visible apply costs.

Main keeps its existing Settings layout. The separate dev preview uses dev's existing Shared agent settings cards; those cards are not backported. The dev PR follows the actual main merge.

Validation:
- Main: 68 core cases in six files plus four mounted UI cases (72 distinct), types: zero errors. Later focused plan/copy runs overlap these cases.
- Main loader reversal: three assertion failures. Earlier alpha loader and actual-manager controls also failed on the old behavior. No timeout or retry change.
- Full Settings UI gate: 94 checks passed. Final affected-section gate: 14 checks passed.
- Successful real-app capture: four cases per branch, 32 PNGs; synthetic identities, inert catalog data and runtime snapshots. Cancel writes nothing; next-start Save uses the real API/reconcile and retains the old running model. New selector targets are 44px high; no horizontal overflow, page errors or CSP reports.
- Every current PNG was visually checked. Main's final 16 are byte-identical to the prior cleared visual delta; all 16 dev previews were inspected. EN phone result identifiers wrap at hyphens. An existing backend helper glyph is outside the changed controls; PNGs alone do not diagnose its font fallback.

Reproduce the focused behavior with `vitest run tests/default-model-scope-m3518.test.ts tests/shared-default-adoption-m3518.test.ts tests/default-model-apply-m3518.test.ts tests/classic-behavior-settings.test.ts tests/settings-apply-job.test.ts tests/model-resolve.test.ts tests/settings-default-model-ui-m3518.test.ts`. Captures use `scripts/manual/smoke/smoke-default-model-effects-m3518.mts` with `REPO`, an owned `PW_DIR`/`CHROME`, and `OUT`. Main's helper uses its existing fixed-port fixture (`HP` override); dev uses its existing ephemeral fixture. Source heads, hashes, measurements and explicit proof limits are in [verification.json](verification.json).

| Branch / case | Captures |
|---|---|
| main / desk-light-en | [Scope](main/desk-light-en-matching-backend.png) · [Choice](main/desk-light-en-next-restart-choice.png) · [Confirm](main/desk-light-en-restart-confirm.png) · [Result](main/desk-light-en-saved-next-restart.png) |
| main / desk-dark-zh-TW | [Scope](main/desk-dark-zh-TW-matching-backend.png) · [Choice](main/desk-dark-zh-TW-next-restart-choice.png) · [Confirm](main/desk-dark-zh-TW-restart-confirm.png) · [Result](main/desk-dark-zh-TW-saved-next-restart.png) |
| main / phone-light-en | [Scope](main/phone-light-en-matching-backend.png) · [Choice](main/phone-light-en-next-restart-choice.png) · [Confirm](main/phone-light-en-restart-confirm.png) · [Result](main/phone-light-en-saved-next-restart.png) |
| main / phone-dark-zh-TW | [Scope](main/phone-dark-zh-TW-matching-backend.png) · [Choice](main/phone-dark-zh-TW-next-restart-choice.png) · [Confirm](main/phone-dark-zh-TW-restart-confirm.png) · [Result](main/phone-dark-zh-TW-saved-next-restart.png) |
| dev-preview / desk-light-en | [Scope](dev-preview/desk-light-en-matching-backend.png) · [Choice](dev-preview/desk-light-en-next-restart-choice.png) · [Confirm](dev-preview/desk-light-en-restart-confirm.png) · [Result](dev-preview/desk-light-en-saved-next-restart.png) |
| dev-preview / desk-dark-zh-TW | [Scope](dev-preview/desk-dark-zh-TW-matching-backend.png) · [Choice](dev-preview/desk-dark-zh-TW-next-restart-choice.png) · [Confirm](dev-preview/desk-dark-zh-TW-restart-confirm.png) · [Result](dev-preview/desk-dark-zh-TW-saved-next-restart.png) |
| dev-preview / phone-light-en | [Scope](dev-preview/phone-light-en-matching-backend.png) · [Choice](dev-preview/phone-light-en-next-restart-choice.png) · [Confirm](dev-preview/phone-light-en-restart-confirm.png) · [Result](dev-preview/phone-light-en-saved-next-restart.png) |
| dev-preview / phone-dark-zh-TW | [Scope](dev-preview/phone-dark-zh-TW-matching-backend.png) · [Choice](dev-preview/phone-dark-zh-TW-next-restart-choice.png) · [Confirm](dev-preview/phone-dark-zh-TW-restart-confirm.png) · [Result](dev-preview/phone-dark-zh-TW-saved-next-restart.png) |

USER-LOOK HOLD: keep the PR draft until the Leader releases the visuals. Coordinator alone gates after exact-head Prism approval and green checks. Rollback: revert this fix's production changes; retain the synthetic evidence.
