# Role resource effects (S-129 preparation)

This adapter is private and unmounted. The role writer and automatic expiry owner remain responsible for actor authority, exact policy CAS, authorization-version advancement and refresh after commit. Startup cutover, a running expiry worker, management routes, member leases and stream disclosure are separate activation work.

The existing mode-only adapter accepts the roles-on/off projection. It cannot carry general assignment changes or retained-resource consequences. `createHubRoleResourceEffects` supplies those consequences without becoming a permission entry point. The writer passes its actual actor and request id through a private optional prepare argument; expiry records the local host. Browser payloads and published protocols are unchanged.

## Consequences

- First self-use activation captures current unregistered fleets and publications as manual consent. It refuses group provenance in a never-enabled image.
- An active group resource becomes suspended on an authoritative next-policy denial. Unknown directory facts stay held. Restored permissions leave a suspended resource requiring explicit Resume.
- Manual and code consent survive role or group loss. Explicit personal denies and freshly known ordinary ineligibility can still suspend them. Code issuance provenance and its recorded approver are retained.
- The impact includes effective self-use gains/losses, distinct legacy transitions, unknowns and the MAX-combined fleet-limit change, including newly assigned people without resources. Reducing a still-positive fleet limit does not disconnect existing consent.
- An owner sharing pause is an ordinary raw publication image, including `sharing_paused` and `sharing_epoch`. Role effects never resume it, change grants, withdraw a publication or rewrite an ordinary resource revision.

## Preparation and commit

Preparation binds the canonical policy, Hub/root/realm/directory generation, actual persisted clock, known-person inventory and full raw authority-table digests. Eligibility and group observations use the mount's shared physical read owner and are copied while owned. An old observation cannot become a new authoritative refusal. Unknown does not imply absent membership.

Effects are single-use, synchronous and tied to the exact owning SQLite transaction. A 20-second monotonic preparation budget, current lifetime, exact methods, stable time-sensitive decisions and clock floors are checked through the final transaction fence. Observed failure permanently retires the prepared effect, including policy ABA.

Required resource audit records retain the actual actor. Their stored images and resulting resource-event rows are rechecked after callbacks and at the caller's final fence. Ledger and event history are streamed under a bounded scan; complete expected images account only for this effect's exact captures/suspensions. Ordinary raw tables remain unchanged. Session authentication may advance `hub_people.last_checked_at`; identity, display and status fields stay bound.

No socket refresh occurs inside this adapter. The outer writer/expiry transaction advances the independently persisted authorization version and only refreshes after commit. An owning callback that changes authority, time, raw pause epoch, unrelated lifecycle history or an audit receipt makes the transaction roll back.

## Evidence and rollback

See `docs/evidence/hub-roles-resource-effects-s129/`. Tests use actual SQLite, audit, cutover, role writer/expiry, shared admission and the merged owner Pause service, with fictional directory answers and inert transport sinks. They do not claim a supported live cutover or a running expiry worker. No new UI, asset or response shape exists in this slice; no PNG or cached-shell result is claimed.

Before activation, rollback removes this unmounted adapter and its private provenance argument. Once the later activation writes role state or raises floors, rollback must be forward-only; never restore an older policy/database/floor snapshot.

The current evaluator makes every deny authoritative and incomplete facts return unknown. The adapter's extra `authoritative` qualifier is defensive against a future broader evaluator result, not an additional independently reachable refusal today.
