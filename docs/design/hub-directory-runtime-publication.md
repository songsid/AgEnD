# Directory decisions in the Hub runtime

M-2687 / #3425, following the reviewed mount/cold-recovery foundation #3463. This slice wires the existing participant into the real runtime and FleetManager's **same** settings writer. It adds no AD HTTP route, editor, browser-token release or directory-notice delivery worker. Those remain required before an operator can change AD settings from the web.

## One mounted generation

Normal mounting and cold recovery use `hubServerDatabasePlan` for one complete registry. A running Hub registers `s5-directory-settings` alongside the existing browser epoch, audit and policy components. Off/ordinary fleets still return before importing or opening Hub state.

Before constructing a directory client, the factory validates the full material barrier and compares the client's exact bind-secret bytes with its captured hash. Missing/non-private secrets retain the existing `hub-directory-secret` diagnosis. Material is checked again after startup awaits and before publishing the private mounted-directory control.

The control supplies the immutable old-directory proof source, the copied SQL proof basis, and the **same** physical 4/person,32-total pool used by policy/owner eligibility. It is not a public DTO or an authority proof. No browser selects the actor, directory client, PersonKey or database.

The web/member effect fence includes the captured settings head/browser epoch. A committed operation revokes the old generation immediately; the old web listener answers unavailable until remount. The still-bound machine listener likewise returns HTTP 503 with code `unavailable` for requests entering an already fenced generation, before route classification or body reads. Active-generation route/machine bounds remain unchanged. Its DB participant remains physically owned until teardown, so the writer can finish the already-decided secret/manifest/config installation. Replacing it with a getter that requires logical currentness would strand every successful commit after its epoch advance.

After the coherent config reload, the old services close and the successor mounts under its exact decided material. The private publication/disposer belongs to that exact generation. A source from the old generation cannot authorize another operation.

## Recovery before mounting

The writer exposes only a validated boolean distinguishing a directory journal from a rename journal. Rename-v1 recovery retains its existing path and does not require a directory DB or HTTP registry import.

For a directory journal, `HubRuntime.recoverSettings` snapshots the target, loads the complete build registry, then borrows a strictly validated existing DB participant for the synchronous call to the **same writer's** `recover()`. The borrowed pointer is cleared and its DB closed before returning. No directory client or listener starts during recovery. Stop, a newer recovery or a new apply cancels a held import before physical effects begin. Once a durable decision is being physically completed, its existing roll-forward rules still apply.

A recovery refusal fences/drains only this local server and reports a visible server storage hold. An unchanged member link to a different Hub stays connected: that binding uses its own locally confirmed receipt and has no authority over this server's directory journal. An explicit member disconnect/rebind still takes effect, and an initially held local server does not prevent independent member startup. A server-specific generation fences queued server creation/start without cancelling the member transition. FleetManager does not fall through to normal apply on refusal/cancellation. Runtime apply independently refuses any still-pending journal, so another caller cannot use ordinary migration/creation as a recovery fallback. Lost authority stays lost and visible; neither path recreates zero or improvises a rollback.

## Evidence and release limit

Focused tests use the real initializer/seal, production S3 handler and CA-verified owned HTTPS listeners with an inert directory driver. They exercise proof → writer → SQL → old HTTPS unavailable → remount available; cold recovery at staged/decision/secret/manifest/config boundaries with the original runtime/DB closed; lost-head refusal; held-import stop/replacement/apply; shared-pool overload/retry; startup material/secret races; and rename-v1 recovery without a DB. FleetManager itself runs only with a recording runtime in its isolated fixture: no live-fleet lifecycle handler is driven.

Existing direct-factory fixtures now seal their intentionally changed private configurations, rather than bypassing the new full-material check. This is fixture preparation, not an operator reconfiguration route.

There is no real directory/account, vendor, native-manager or pilot operation here, and no claim of power-loss acceptance. The originating browser's successor-token handoff, durable full-recipient notice delivery and forward compensation after a real failed mount remain required follow-up integration; public AD routes stay absent.

**Data compatibility:** enabling the Hub on this build registers a required schema component, even while group policy/company join are off. An older binary refuses that DB. Back up the stopped complete state before upgrading a pilot; rolling back requires its matching pre-upgrade state and binary. Never remove authority rows or lower floors/epochs. Reverting the code alone is not a schema rollback.


## Review controls

The startup material tests change the private bind secret while the real member listener's start is held, and again in the final retention callback after the web-listen await. Both require no directory publication, unavailable health, and both local server ports closed. Removing all three startup material assertions is caught; removing only the final assertion is independently caught by the second case. The two earlier assertions provide early refusal before/after member binding; the final full-material assertion dominates publication, so removing an early assertion alone can still be covered by the later one. No separate necessity claim is made for those redundant early checks.

Server-only holds are tested both from recovery and pending apply, including a configured member on first startup, explicit disconnect, and a held server factory/start with a newer pending apply. These lifecycle controls use inert member factories; they claim preservation of the captured current link predicate and owned lifecycle, not remote-Hub network acceptance. A captured-disposer unit control also calls an old publication disposer after a newer one and requires the newer pointer to survive; this is an explicit private-callback interleaving, not a claim that normal serialized mounting produces it.


The company-join epoch control deliberately changes only the session epoch, leaving the settings head inconsistent; this must fail closed and still surface temporary unavailability. It remains unchanged. A second control uses the actual settings writer's coherent epoch/head decision and requires the old machine join challenge to return the same 503 without credentials. The listener fence is retained; no test makes the old generation current again.
