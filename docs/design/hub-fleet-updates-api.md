# Hub Fleet updates — phase 3 (M-3144 / M-3145)

Build in three slices: reusable durable idle admission (3a), Hub requests/status (3c), then opted-in Fleet dispatch
and existing updater composition (3d). No real updater is driven in tests. One later rehearsal proves actual updates.

## UI protocol agreed with web-claude

Hub overview adds `recommendationRevision` and Fleet rows add `updatesAllowed:boolean|null` (null for old/unknown)
and `updateRequest:HubFleetUpdate|null`.

```ts
interface HubFleetUpdate {
  id: string; fleetId: string; version: string;
  requestedBy: { name: string };
  requestedAt: number; expiresAt: number; updatedAt: number;
  waitingSince: number|null; startedAt: number|null;
  state: 'queued'|'waiting'|'updating'|'done'|'rolled-back'|'expired'|'cancelled'|'refused'|'failed';
  reasonCode?: string; currentVersion?: string;
}
```

`queued` means not yet accepted on the Fleet: display Sending when currently connected, otherwise Waiting for connection.
`waitingSince` is stable through idle observations; use it for the waiting-since sentence. `currentVersion` gives the
already-current/rollback release. Expiry reason is `busy-24h` after acceptance or `offline-7d` before acceptance.

Admin + CSRF:

- `POST /hub/v1/admin/fleet-updates {fleetIds:uuid[],ifRevision:number,idempotencyKey:uuid}` →
  `{requests:HubFleetUpdate[],refused:[{fleetId,code}]}`. One or many IDs; target is always the server's saved effective
  recommendation. No body version or actor. Stale revision → revision-conflict; missing recommendation → no-recommendation.
- `POST /hub/v1/admin/fleet-updates/:id/cancel` cancels only a queued/waiting request.

Per-Fleet admission refusal codes: owner-disabled, not-service, already-current, request-open, unsupported, revoked,
not-found. Fleet failure/refusal reasons additionally include version-not-found, npm-unavailable, no-permission,
update-running, launch-failed, rollback-failed, interrupted. Terminal codes are fixed vocabulary, never exception text.

Local Fleet authenticated admin + CSRF, no public-link writes:

- `GET /api/settings/hub/update-consent` → `{on,available,reason?:'not-service'}`.
- `PUT` the same path `{on}` → same shape. Persisted against the selected Hub/Fleet pairing, off for a new binding;
  not a fleet.yaml boolean that could silently grant another Hub permission. No new extra confirmation beyond the
  specified local UI Allow/Cancel flow. Disabling cancels a waiting request.

Ridge owns the server/Fleet APIs and notices. Web-claude owns3b/3e and notice rendering. Exact owner-notice actions
will be request-ID bound; Update now keeps today's explicit local confirmation, Cancel does not need another confirm.
These routes and UI fields are **planned until the composition slices land**; the idle foundation alone enables none.

## Idle foundation (PR1)

`src/update-idle.ts` exports `IDLE_UPDATE_MIGRATION`, `IdleUpdateQueue`, its request/view and launch-control types.
The host supplies a selected SQLite database, current/permission predicates, an idle observation, bounded preparation
and a change observer. It has no import or path to a real updater, child process, network or Fleet lifecycle.

Each request freezes one exact version under a UUID, has one 24-hour waiting deadline from local acceptance and
is durable. Exact repeats return the retained outcome; changed reuse conflicts; only one active request can exist.
The caller invokes `pump()` on new admission and idle/activity events. One unreferenced deadline timer expires waiting
or preparing work even when no activity event arrives. Unknown idle observations do not grant admission.

Preparation enters starting; the launch adapter must call `control.current()` after awaits and `control.claim()`
immediately before spawn, with **no await between claim and side effect**. Claim saves updating before the side effect.
Cancel, expiry, permission change or retiring the host invalidates an unclaimed control. New activity returns an
unclaimed preparation to waiting without extending its deadline. A claimed update cannot be cancelled by this queue.

On restart an unclaimed starting row returns to waiting; updating is never automatically launched again. The later
composition must reconcile that exact request with the existing update marker/version, then call settle(done,
rolled-back or failed). It must not infer success just from a reconnect. Persisting a claim fails → no spawn. The host's
bounded launcher and status notices are separate from this admission mechanism.

## Phase 3 capability ruling

Leader accepted an explicit `fleet-update-v1` hello offer. Members may send up to32 names. If an old Hub closes before
welcome, make one legacy retry on the same authenticated pairing, dropping only the new offer, and log once. Do not
loop. Phase3 stays off on that legacy connection. Hub welcome exceeds16 only to a peer that explicitly offered
fleet-update-v1 (those peers parse32); old peers keep the16 send ceiling. Add an owned beta.3-shaped16-cap codec test
and include the case in the later rehearsal. The transport slice implements this negotiation but leaves production update offers disabled until the request receiver is composed.

## Rollback

PR1 is an unmounted foundation. Revert its code to remove it; retain any additive queue data used by later composition.
Later rollback disables remote-update permission/offer and preserves request/marker evidence. Never weaken ordinary
admin confirmations or trigger a real update as part of validation.

## Startup outcome reconciliation

The composing Fleet host must inspect any retained `updating` request at startup. It compares the exact request marker and running version, settles done or failed (or the verified rollback result), and never launches the claimed request again. A missing or interrupted marker must produce a terminal result rather than keep the single-active queue busy forever.

## Hub request slice

`src/hub/fleet-update-model.ts` supplies strict `fleet.update`, `fleet.update-cancel`, `fleet.update-status` and
`fleet.update-status-ack` payloads. The first two are server-to-member. Statuses have an increasing durable sequence;
ACKs bind the exact request ID, frozen version and sequence. These frames require `fleet-update-v1` on the current
link. The receiving Fleet's permission remains an independent check. `fleet.info.updatesAllowed` is sent only on a
negotiated phase-3 link, so an older Hub never sees the new strict-object field.

The Hub saves each press with its actor and exact input under the idempotency ID. An atomic audit failure rolls back
all requests from the press. The target is the saved recommendation, with its revision rechecked in the transaction.
Permission, service mode and the current Fleet binding are checked; revocation terminates open requests. Statuses from
another Fleet, generation, version or stale link cannot change them. Reused status sequences with changed content and
backward updating-to-waiting transitions are ignored. Optional request/status traffic cannot end ordinary member work.

Cancellation adds `cancelRequested:boolean` to the view. A never-sent request cancels immediately. Once it has been
sent, the Hub retries cancellation until the Fleet confirms a terminal status; it cannot claim cancellation while the
Fleet may already have launched. A new press for a different recommendation retains the old request as a predecessor:
the new target is sent only after the old one confirms cancellation. If the old update already started, the replacement
is refused. Concurrent presses for the same target return the same open request.

Only live links are retried (30 seconds); offline Fleets are not polled. The seven-day queue deadline is checked on
ready/read/request reconciliation. A Fleet acceptance reports its separate 24-hour idle deadline. The future receiving
composition must persist cancellation tombstones, statuses and ACK state, and must not block the link on npm work.
