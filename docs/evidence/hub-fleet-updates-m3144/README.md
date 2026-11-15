# Hub update requests, M-3144

This slice mounts durable administrator requests and the negotiated fixed-shape request/status frames. The Fleet receiver, opt-in endpoint, owner notices and real updater composition follow separately. This slice does not run an updater.

Validation: the initial two tests failed before implementation because the previous strict Fleet report rejected updatesAllowed (wire admission red, not a claim about exercising request behavior). The seven final request cases plus adjacent recommendation, version and protocol tests pass 46/46. Separately added audit-failure rollback and late-status/cancellation-race cases pass (one selected case each); the saved-recommendation case also pins one audit entry for an idempotent press. Native source/test programs exit 0. Test fixtures use temporary SQLite, HTTP and inert directory/transport; no new TLS, real Fleet, npm, vendor or updater campaign.

Covered: server-owned version/revision, actor-bound idempotency, CSRF/admin authority, disabled owner consent, seven-day offline expiry across restart, sent cancellation confirmation, predecessor cancellation before replacement, monotonic/conflicting/foreign statuses, legacy reconnects, service mode, no downgrade, revocation and atomic audit rollback.

Rollback disables the fleet-update-v1 offer/routes while retaining request rows. The receiving Fleet remains independently responsible for authority, idle checks, cancellation and startup reconciliation. No real-update claim is made; one later rehearsal covers it.

Review delta: three deterministic cases pin a new-generation status before queued reconciliation, request-open while updating or cancelling a predecessor, and a second authorized administrator reusing the first administrator's operation key (3/3 selected). The CI shard-4 failure was an outdated HTTP feature-list assertion; adding the mounted fleet-update-v1 capability makes the affected group-mount suite pass 20/20. The duplicate skill section is removed: companion UI PR #3958 consolidates the user instructions into the existing Fleet versions bullet. No product source change in this delta.
