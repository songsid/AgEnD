# Hub update requests, M-3144

This slice mounts durable administrator requests and the negotiated fixed-shape request/status frames. The Fleet receiver, opt-in endpoint, owner notices and real updater composition follow separately. This slice does not run an updater.

Validation: the initial two tests failed before implementation because the previous strict Fleet report rejected updatesAllowed (wire admission red, not a claim about exercising request behavior). The seven final request cases plus adjacent recommendation, version and protocol tests pass 46/46. Separately added audit-failure rollback and late-status/cancellation-race cases pass (one selected case each); the saved-recommendation case also pins one audit entry for an idempotent press. Native source/test programs exit 0. Test fixtures use temporary SQLite, HTTP and inert directory/transport; no new TLS, real Fleet, npm, vendor or updater campaign.

Covered: server-owned version/revision, actor-bound idempotency, CSRF/admin authority, disabled owner consent, seven-day offline expiry across restart, sent cancellation confirmation, predecessor cancellation before replacement, monotonic/conflicting/foreign statuses, legacy reconnects, service mode, no downgrade, revocation and atomic audit rollback.

Rollback disables the fleet-update-v1 offer/routes while retaining request rows. The receiving Fleet remains independently responsible for authority, idle checks, cancellation and startup reconciliation. No real-update claim is made; one later rehearsal covers it.
