# Hub quick pairing (S-90, alpha only)

Group permissions start off. An eligible signed-in person with a fresh `pair_fleet` group allowance may create an
offer on the Hub welcome page. This skips the administrator's wait only. The existing one-time code, exact pairing
fingerprint, fleet-local Settings confirmation, Hub owner confirmation and persisted Hub key pin remain necessary.
No agent is published by pairing. The publication workflow and its separate permission still apply.

The final manual-fallback clarification is recorded on [#3298](https://github.com/songsid/AgEnD/issues/3298#issuecomment-6715088331).
Explicit administrator approval is a separate manual proof; it can exceed the self-service maximum. Existing retained
manual fleets nevertheless count against later automatic enrollment. An explicit person deny and authoritative owner
ineligibility still refuse access. The quick path always requires a fresh `source=group` preparation, never legacy or
manual provenance. A welcome projection is never authority.

## Admission and commit

`POST /hub/v1/quick-pairing` authenticates the session's immutable PersonKey; no login selector or person input is
accepted. It charges a bounded lookup budget before directory I/O (five per person/minute, 48 globally/minute).
An admission preparation is discarded without creating provenance. Only its current group permission allows an offer.
Claim obtains an entirely fresh exact preparation and commits it with the credential, required audit and notice outbox
in one immediate SQLite transaction. Directory I/O occurs outside transactions. Lifetime, session, policy and exact
pairing proofs are checked again after awaits and required audit callbacks.

One automatic live offer is retained per person. Replacing it invalidates its old code and pending claim atomically.
An existing manual offer is preserved and directs the person to that workflow. Quick creation stops at 48 retained
pairing records; administrator creation retains the existing global 64 limit and headroom. Expired records are removed
at offer creation. Personal automatic admission/claim counts retained credential-bearing owned fleets, including manual
and group-suspended fleets, plus unexpired automatic reservations. Pending manual attempts are not automatic reservations.
The existing hard 256 retained-fleet cap remains. Stopping the exact own offer frees its reservation. Policy off and
explicit person denies cancel affected pending automatic offers in the same policy/version transaction.

Unknown membership holds the current action and creates no new reservation or resource suspension. A complete negative
refuses and invalidates a pending automatic attempt. The fleet pairing client's existing unknown-outcome hold remains
fail-closed: a missing credential response is never blindly retried. The page says when it cannot determine completion;
the owner can inspect/revoke the exact retained fleet or stop/restart the attempt.

## Notices and revoke

The new credential cannot be returned unless durable notices for the owner, configured administrator and other active
owned fleets, with queued audit records, commit with it. The initiating Hub session is excluded from its own notice.
Other sessions get authenticated SSE; offline sessions read the same retained record at their next sign-in. Notice
reads and acknowledgements require a current eligible session, independently of pair/publish permission.

Member delivery requires both `welcome-caps-v1` and `pairing-notices-v1`. The Hub retains queued/failed targets and retries
after ready reconnects. A socket write is not delivery: the member first retains the notice and local audit in its own
SQLite transaction, then sends an exact ACK. Lost ACKs replay safely, including a monotonic revocation update. Labels are
bounded untrusted text, never markup. Wire/notice DTOs contain only the notice/fleet ID, generation, label, time, generic
group-policy source and revoked projection; no code, credential, directory DN or group identities.

The private fleet Settings endpoint supplies its retained inbox. The existing visible-only member poll presents it on
the fleet page (at most five seconds after receipt); payloads never enter the general fleet/guest SSE stream. Older
members receive no new frame and their target remains queued. Per-Hub and member inboxes cap at 1024 records and refuse
new automatic credentials/ACKs rather than discard an unread offline security notice. This conservative capacity needs
operator attention before saturation; no silent eviction is implemented.

Hub and member reads expose the complete bounded retained history (at most 1024 records), not an unreachable newest-100
window. The page starts with 100 rendered notices; its folded history adds 100 at a time with **Show older notices**.
An exact Hub ACK checks current person/session and the exact recipient row independently of any list window. The page
ACKs only the displayed notice or expanded history, sequentially; collapsed rows do not cause an ACK request burst.
Transport ACK still means durable member retention, and every such retained notice remains reachable in Settings.

`POST /hub/v1/fleets/:id/revoke` narrows the current owner's exact fleet generation. It remains usable after losing
self-service permission, requires current eligibility plus same-origin/CSRF, checks ownership before any link effect
and again inside the commit, then fences the named fleet and refreshes other links after commit. Administrator notices
use the existing configured-admin revoke route. Buttons require one explicit click, with no second confirmation.

## Validation and rollback

Focused suites cover atomic failure, quota races, stale sessions/claims, replacement/expiry, mixed versions, retained
notices, forged ACKs, label injection and exact owner revoke. `scripts/manual/hub-quick-pairing/accept.mts` runs the real
sealed Hub and fleet web Settings against the recorded fake LDAPS wire peer, with no daemon, native pane, model, account
or tmux. Its connector redirects only the requested directory port 636 to its own ephemeral listener; TLS verification and
critical extended-DN BER remain production code. PNGs cover desktop/phone, EN/zh-TW, light/dark, previous UI and cached CSS/client.

New migration components are `s90-pairing-notices` (Hub) and `s90-pairing-inbox` (member). Before deploying, back up the
matching private Hub/member state and monotonic-floor set. Rollback needs the matching older binary and pre-upgrade
backup; an older strict binary cannot read automatic pairing metadata/new components. Never reset an independent floor
to make a stale DB permissive. This PR does not activate group policy or deploy to any fleet.
