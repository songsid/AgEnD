# Hub roles: canonical consumers before activation

This is the first S-129 integration slice for M-3010. The accepted role semantics are
`docs/hub-ux-review-m2902` at `9e000625658d55c6d8f522cfbae2a01448a9cc37`.
It builds on the inactive model, writer, expiry settlement and cutover from
#3767, #3772, #3777 and #3783.

## Delivered boundary

The policy remains one physical `hub_group_policy` row. `roles/read.ts` strictly
distinguishes its group and role documents and retains the exact stored bytes.
No reader invents group rules for personal assignments. The legacy store's
`read()` and whole-document `replace()` still reject role documents, so an old
group editor cannot overwrite the role graph.

The existing policy store owns the same 4/person, 32/total physical directory
admission pool in either document format. Its data-only `canonical()` is distinct
from `authorizationPolicy()`: role authorization requires the configured root and
the real expiry settlement's synchronous persisted clock fence. Missing wiring
refuses. No new LDAP pool is created, and admission remains held until the
physical promise settles.

Existing self-use checks, resource lifecycle and operation permits consume the
complete document. Personal assignments use fresh eligibility; relevant group
subjects use fresh GUID membership. MAX quotas, zero limits, denies, the three
self-use states and roles-off projection retain the model's semantics. Existing
manual/code resource bodies and sources stay intact. Unknown holds without
removal; restored self-use does not resume an already suspended resource. A
captured role decision expires at its next assignment deadline, including during
required audit callbacks and before a later registration commit. A retired
operation proof cannot revive after the clock or document returns.

The welcome keeps its existing version-one shape. It does not disclose role or
assignment IDs and does not send unfamiliar reason strings to cached clients.

Directory Save and compensation rebind only generation and revision on the
current complete document. Both mounted and cold source projections collect all
retained group subjects and scopes, including expired/future/off assignments.
References retain distinct DN assertions for a GUID. The bound is 512 references
(256 assignments with subject and scope), with no truncation. The existing
coordinator, physical candidate-directory close, final proof basis, CAS, audit,
floor, browser epoch and compensation mechanism remain in charge. Compensation
never restores old assignments or denies.

`roles/authority.ts` prepares a management proof for an actual exact Hub session,
with a fresh immutable-person eligibility read through that same pool. It binds
one of the five management permissions, canonical bytes, transport authorization
epoch, directory method, session identity and generation lifetime. A proof lasts
at most five seconds from its directory observation, uses wall and monotonic
clocks, and becomes permanently unusable on a failed fence. Acquisition also has
a 20-second preparation budget; this is not a claim that a physical LDAP close
returns within that budget. The persistent clock callback is mandatory for role
documents. The legacy document authorizes management only for the configured
root. This proof is not yet composed into production management routes.

## Required before activation

This slice does not invoke cutover, register the role migrations, advertise a
role capability, mount role writer endpoints or grant an auxiliary administrator
access to existing management routes. Existing root-only presentation is not an
authority proof. No UI, team/usage endpoint or approval protocol is added.

The remaining S-129 work must:

1. Wire named management permits into the actual services, owner lookup and
   mutation/disclosure boundaries, including after reentrant audit callbacks.
   Preserve the actual actor and approver. Add the session-independent, fresh
   `join.manage` issuer proof before first issuance, while retaining exact
   committed delivery after issuer loss.
2. Support the acting administrator's own directory reauthentication and
   candidate eligibility independently from the configured root's candidate
   eligibility. Keep host-owner/rescue rules separate.
3. Supply real retained-resource effects, expiry settlement scheduling and clock
   fences at dispatch, tool, release, member leases and SSE disclosure.
4. Select/validate the complete role registry in normal and cold startup, then
   invoke the atomic cutover only after every authority consumer is converted.
   Cold recovery must never run migration functions or create missing authority.
5. Verify mounted code/invitation redeem/ACK recovery and unchanged root self-use
   (explicitly transferred from S-128 acceptance item 2), then run real-route
   negatives, mutations and the final parity review.

## Evidence and rollback scope

Tests use real SQLite, audit, transport floor and Hub session logic with inert
directory, pane and transport boundaries. The directory-decision tests use owned
private WAL files and inert staged-image hashes. They do not claim a mounted
canonical role route, real LDAP/account, browser, native OS or live Fleet run.

Skills are unchanged because this internal preparation adds no user-facing
operation or capability. No PNGs are applicable to this server-only slice.

Before activation, reverting this slice restores the previous legacy consumers;
it creates no role policy or migration marker in a deployed Hub. After a future
activation, reverting only readers or restoring a policy snapshot is unsafe:
use the established forward recovery or coherent backup procedure instead.
