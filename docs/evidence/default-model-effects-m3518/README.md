Shared backend/model defaults

The raw Fleet defaults used to be merged independently into every agent: an agent overriding the backend still received the other backend's model. The model resolver and Settings inheritance counter repeated that backend-blind fallback. Since both fields are cold settings, Settings then used the generic stop/start reconcile.

The fix scopes a model to the exact declaring backend, preserves explicit agent models and applies the same rule to ClassicBot's room → Classic defaults → Fleet defaults chain. Changing the shared backend clears the prior model selection. The form counts only matching-backend model consumers and previews effective identity changes, including gained/lost model inheritance when the default backend changes.

Settings offers a safe next-restart choice and an explicit restart-running choice before the first write. This path does not call individual model switching, which persists own overrides and may restart on an unconfirmed CLI result. Deferred identity differences stay pending through unrelated reloads, without hiding other cold changes. Consent is bound to the saved values and runtime owner; stopped/paused agents stay stopped. A new runtime adopts the saved settings. Running identity readouts/command dispatch keep the old backend/model until then.

Validation (runs overlap):
- Base loader regression: two assertion failures, demonstrating cross-backend model leakage.
- Base manager control: the actual reconcile reports a restart as done instead of next-start. Fixed actual-manager cases cover deferred apply, unrelated hot/cold edits, stopped/paused agents, explicit consent, unchanged raw inheritance, new runtime adoption, own model edits and idempotency.
- Config/model/Classic/Settings affected suites and types are recorded in the final packet.
- Real-app captures use synthetic identities and runtime snapshots in a scratch home. No live Fleet or provider process is restarted, switched or probed by the capture. A confirmed real CLI model switch is not claimed.

Capture index and final verification will be added after the clean-source capture run. This is a user-look hold; the author does not merge.
