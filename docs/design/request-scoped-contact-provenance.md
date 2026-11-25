# Request-scoped contact provenance

Status: design for four-backend review and user approval; no product implementation.
Source baseline: `8052c59ee292740b4234c263be47ee95dd27e4fb` on
`release/2.3.5-alpha`. This follows the user-approved two-phase contact-lock
simplification. Phase 1 preserves signed-in account identity separately from
approval authority. This document proposes Phase 2.

## 1. Policy and limits

A contact decision belongs to a request and an exact operation, not to an Agent's
lifetime. Remove the accumulated per-Agent `unknown`/`mixed` origin as a permission
switch. Retain history as explanation. Recognizing an administrator does not need
browser verification; giving an approval or other go-ahead still does.

The following approved policy is preserved:

1. One identity is platform plus user id; an adapter is transport. An explicitly
   identified host operator counts as an administrator. An account-less device
   does not borrow another browser's identity.
2. An administrator's new independent request proceeds. Work started by someone
   else retains that request's scope through linked delegations and continuations.
3. Restricted-room members and guests need a contact approval. Free-room members
   do not. A Hub answer turn remains protected, with only the approved M-3661
   labelled pass-through exception described below.
4. An elapsed 30-minute window never proves that a Hub answer turn ended.
5. Exact-operation binding, atomic decision/admission, once-only delivery and
   current administrator/incarnation checks remain. Standing grants are optional.
6. A later administrator message never cleans an existing outside request. A
   person approves the particular operation; there is no blanket origin reset.

Contact permission is permission to deliver a message. It does not approve the
receiving Agent's actions, confer the owner's authority, or grant credentials.
The existing M-3384 endorsement rule remains: approving a contact or using an
administrator-written standing grant does not copy a restriction onto the target.
The target's later contacts are judged by its own work context. Approved content
may therefore flow onward without another contact approval. Keep that consequence
plain on the decision card.

This is not a sandbox, secret isolation or semantic non-interference. A model
with shell/keys can still misuse them. Native CLI guard coverage remains as
reported today, including its unsupported paths. In a long-lived CLI conversation,
old outside text can influence later reasoning even after tracked work completes.
The protocol prevents laundering of *tracked work*; it cannot prove that a new
model action was uninfluenced by an earlier sentence. Agent instructions must
continue to treat retained outside instructions as outside data. An action broker
or isolated execution would be separate work, not a claim of this design.

## 2. Current controls and the change

| Current source | What code does today | Phase 2 change |
| --- | --- | --- |
| [src/contact-auth-service.ts:39](../../src/contact-auth-service.ts#L39) | Reads instance-wide origin; Free Classic bypasses the contact hold | Read the server-owned active request context, with Free applying to room-origin work only |
| [src/contact-auth-store.ts:123](../../src/contact-auth-store.ts#L123) | Merges origin into a row keyed by instance | Keep historical rows read-only after cutover; no permission lookup from the union |
| [src/fleet-manager.ts:8913](../../src/fleet-manager.ts#L8913) | Human receipt creation also accumulates origin | Admit a root/continuation context from the receipt; keep identity and authority separate |
| [src/fleet-manager.ts:6247](../../src/fleet-manager.ts#L6247) | Shared durable send admission, current daemon boot and contact decision | Freeze request context before the same admission; keep currentness checks |
| [src/contact-auth-store.ts:245](../../src/contact-auth-store.ts#L245) | Operation hash conflict detection and ticket snapshot | Include immutable context binding in new operation equality, without loosening old equality |
| [src/contact-auth-store.ts:380](../../src/contact-auth-store.ts#L380) | Decision and outbox admission share a transaction | Preserve this; never send directly from a UI callback |
| [src/fleet-manager.ts:3150](../../src/fleet-manager.ts#L3150) and [src/daemon.ts:7317](../../src/daemon.ts#L7317) | Daemon-owned Hub input/end lifecycle, restored-turn reconciliation | Reuse real input/turn fences; stop using elapsed expiry to lift a still-running answer scope |
| [src/fleet-manager.ts:25608](../../src/fleet-manager.ts#L25608) | Board notices snapshot origin and later merge it into an Agent | Snapshot request context on derived notices; no lifetime merge |
| [src/native-mcp.ts:87](../../src/native-mcp.ts#L87) | Native tool capability binds original turn and current policy | Add context binding to the existing capability; do not trust a tool argument |

These are implementation anchors at the stated baseline, not claims that Phase 2
already exists. Current permission/grant incarnation fencing and current platform
actor verification remain authoritative. No language model grants permission.

## 3. Identity, request context and endorsement

Use one normalized `PersonKey = {platform, userId}` for humans; adapter id remains
in the immutable receipt as proof/routing metadata. Do not collapse Discord,
Telegram, Hub people, Hub agents or Hub assistants into one namespace. A Hub actor
is `{hubId, kind, id}` from the accepted authenticated Hub question or room proof.
Display names never supply identity. A verified guest is still a guest.

Proposed server-owned records:

```text
RequestContext
  id, rootReceiptOrAcceptedHubDeliveryId, parentContextIds
  initiatingActors[]                 # normalized, immutable; may be unknown
  ingress                           # owner / restricted-room / free-room / guest / hub
  sourceInstance + incarnation
  roomOrGuestAudience                # exact origin audience; not a mutable name
  contactPolicy                     # normal / approval-required / hub-labelled / hub-blocked
  returnAudience                    # who can receive the result
  state                             # queued / active / awaiting-children / completed / cancelled
  activeTurnBinding?                # daemon boot + owned logical turn/input identity

OperationContext
  operationId, source + target incarnations, actual tool verb
  immutable requestContextIds + payload digest
  contactEndorsement?                # approval/grant id for this delivery only
```

These are logical contracts, not a committed storage format. Prefer companion
records beside the existing outbox/tickets rather than modifying strict older
journal JSON. Atomic admission must bind the companion and message, with a
specified prepare/commit barrier if they cannot share a transaction. Missing or
conflicting required metadata means *this work is not deliverable*, not permission
to fall back to an unlabelled send.

The model cannot choose or erase a context id, actor, endorsement or active-turn
binding. The daemon stamps it at actual input. Calls without a current binding
cannot select a historical context by correlation text. Data that resembles a
header is ordinary text. UI and `delivery_status(detail)` show provenance and
`authority: none` separately from genuine human receipt authority.

Approval endorses one contact edge. Keep the initiating actors on the audit and
message as information, but do not treat the endorsed receiver as a new restricted
room member. A reply on an exactly matched obligation goes back on that obligation
without a second contact application. It carries the result's audience warning;
it is never a new human go-ahead. Existing pre-approved-return identity,
incarnation and delivery checks are retained.

## 4. Mode matrix

Verification below means proof sufficient to approve/manage, not the person's
identity. “Normal” still obeys tool sets, source/target liveness, configured receiver-side restrictions,
Hub sharing rights, scope, file/routing fences and ordinary go-ahead checks.

| Originating mode | Initiator | Browser/receipt verification | Cross-Agent result | Recovery / outcome |
| --- | --- | --- | --- | --- |
| Free room | Current administrator | Verified | Normal | No contact card |
| Free room | Current administrator | Unverified signed-in account | Same normal contact identity; no approval authority | Verify only for a go-ahead |
| Free room | Ordinary identified room member | Verified | Normal, as Free is deliberately open | Receiving Agent's instructions still apply |
| Free room | Ordinary identified room member | Unverified | Same Free policy; no go-ahead | No verification invented from room membership |
| Restricted room | Current source administrator | Verified | Normal | No inherited lifetime restriction |
| Restricted room | Current source administrator | Unverified signed-in account | Same normal request identity; no approval authority | Verify only when approving/managing |
| Restricted room | Non-admin member | Verified | Hold exact operation unless a live exact grant matches | Continue / Always allow / Decline |
| Restricted room | Non-admin or unidentified member | Unverified | Same hold; unidentified cannot create a standing grant | One exact approval; no agent-wide unknown |
| Either room mode, but **guest ingress** | Guest | Verified guest identity | Hold; guest scope is not Free-room input | Target managing admin decides |
| Either room mode, but **guest ingress** | Guest | Unverified/unidentified | Hold exact operation; do not infer an account | Sign in / verify admin in the same card, then decide |
| Either room mode, but **Hub ingress** | Hub person | Authenticated Hub identity, no local-owner authority | M-3661 permitted labelled send only; other contacts refuse or hold as specified below | Explain the return audience and exact refusal |
| Either room mode, but **Hub ingress** | Hub person or non-person actor without sufficient proof | Name-only, missing proof or wrong destination | No pass-through; fail this operation closed | Retry only after a fresh valid accepted request, never guess by name |
| Ordinary Fleet work | Current administrator's independent request | Verified | Normal | No card, regardless of old retained history |
| Ordinary Fleet work | Same administrator | Unverified signed-in account | Same identity and normal contact; no go-ahead | Existing verification for approvals |
| Ordinary Fleet work | Continuation of restricted/guest/Hub work | Any later administrator message | Retain that work's scope | Decide that work's exact operation; administrator text does not clean it |
| Ordinary Fleet topic/DM | Native non-admin, if existing access policy admits them | Native receipt or otherwise identified | Preserve the configured ordinary/free contact policy; no new lifetime hold | They are not an owner go-ahead; restricted/guest/Hub context still takes precedence |
| Ordinary Fleet work | Agent performing its own assigned work | Current server-owned task, no external parent | Normal within its assigned tool/profile limits | No fabricated human authority |

The two “either room mode” rows describe a different authenticated ingress, not
someone speaking as a Free-room member. A guest or Hub request cannot become
Free-room work simply by selecting a target whose own room mode is Free.
This precedence needs explicit reviewer/user confirmation; it avoids using a
Free intermediary to launder an already restricted request.

Transport and deployment coverage:

| Deployment | Identity and policy | Boundary that must remain |
| --- | --- | --- |
| Discord ClassicBot restricted/free | SDK actor id; source room mode determines native member policy | Room replies stay in their room; source and target incarnation match |
| Persona bot / several bots in a guild | Platform + user id across configured sibling bots, not “a different person per bot” | Correct bot sends replies; routing unchanged; preserve existing central admin gate and distinct Free-mode management entitlement |
| Telegram group / DM | SDK `from.id` or callback actor; anonymous/unknown sender is not invented | No Discord/Telegram id collapse; group/channel names are not human proof |
| Web signed in as an account, any link | Server session-account identity; current role determines admin status | Unverified identity is never approval; read/guest sessions do not acquire admin writes |
| Web-only Fleet | Explicit supported host/TOTP sign-in is host operator | Account-less approved device is not silently the approving administrator |
| Hub 1:1 | Stored authenticated question's actor id; verified directory name is display metadata | Current answer turn and accepted destination; no owner/account substitution |
| Hub group | Negotiated signed stable id **and kind** from the room-asker companion | Legacy name-only proof cannot enable labelled pass-through |
| Another Fleet's Hub actor | Hub-qualified id/kind, never this Fleet's administrator automatically | Hub membership or a sharing owner is not local authority |
| Paired Windows | Existing native turn capability plus a negotiated context version | Original-turn binding survives awaits; missing capability cannot silently drop provenance |
| Local app / header-token ingress | Existing unverified source, no invented signed-in person | No owner go-ahead; inside a restricted work context it cannot erase that scope |

## 5. Hold and work lifecycle

1. **Admit input.** Read the real receipt/session/Hub proof, normalize identity,
   evaluate current roles, and create a root context or join an exact existing
   parent. A typed body, tool argument or fuzzy name cannot select the parent.
2. **Start actual work.** Queue first, then bind context to the current daemon's
   exclusive input/turn. Outside-labelled input must not be pasted into an
   unrelated running turn. An administrator message aimed at that running work
   is a continuation and inherits its scope; a new independent request waits for
   its own turn. No “latest speaker wins”.
3. **Create a contact operation.** Snapshot actual tool verb, bytes/files, target,
   both incarnations and context before delivery. Match a grant deterministically
   or create exactly one immutable ticket. A changed retry conflicts.
4. **Hold.** One durable ticket is projected next to the held send, in the source
   chat, General on Discord/Telegram, and Needs you on every link. These are views
   of the same ticket, not four independent applications. Pending delivery is not
   retried by the agent.
5. **Decide.** Re-read current target managing administrator/approver, ticket and
   policy revisions, expiry and both incarnations. Commit approval/grant-use/audit
   and outbox admission atomically. Decline/expiry never dispatch. A timer/sweep
   sends the existing once-only status notice; approved notices distinguish queued,
   delivered and unconfirmed. Status messages contain no new authority.
6. **Continue.** Approved contact uses the existing endorsement semantics. Unendorsed
   M-3661 relays carry their label through the actual receiving turn and exact
   returns. Queued reports, task wakes and schedules retain their captured context;
   they never revive a finished Hub answer turn or its lease.
7. **End.** A real owned turn end, explicit cancellation or fresh-runtime boundary
   retires the *active binding*. Awaited children retain immutable work records.
   A later exactly matched report starts its own scoped continuation. A child
   cannot become normal merely because the parent stopped being active.
8. **Recover after crash.** Reconcile the current daemon boot/turn and durable
   admission/obligation records. An unknown active state blocks that work from
   dispatch, with its card explaining Continue or Decline; it does not install a
   new lifetime restriction on every future request. Timeouts expire applications
   or cancel work; they never convert outside work to administrator work.

A context is eligible for retention cleanup only after all its tracked operations
and children are terminal. Pruning removes evidence after its retention policy;
it does not transform pending outside work into normal work. Capacity pressure
refuses only the new affected work with a reason; it must not create a global
`unknown` permission state.

Tracking cannot infer semantic parentage from a model's memory. The implementation
must enumerate supported system-owned parent edges (input, delivery/return,
board notice, scheduled work). Until an edge carries context end to end, refuse
creating that durable derivative from outside-labelled work. Do not promise that
an arbitrary script, manually copied text or raw shell is confined by this gate.

## 6. One card and inline verification

The card identifies the sending Agent and exact target, initiating person/platform,
message, return audience, concrete reason and expiry. Actions are **Continue
(approve once)** / **Always allow…** / **Decline**. Standing grants remain optional,
with the existing exact person + source room/Agent + target + verb + both
incarnations, default seven days and explicit expiry/revoke. A complete multi-person
scope needs explicit selected people; unknown or non-human identity cannot become
a person grant by inference.

An administrator who is signed in but unverified sees the *same scoped card* with
inline **Authorize this browser**. This intentionally replaces Phase 1's count-only
projection: recognition/current role authorize the scoped read, not the decision.
Do not expose full cards to unsigned users, guests, read-only sessions or unrelated
administrators. Public-link admin parity keeps the same session, CSRF, current-role
and action checks as localhost.

Use the existing account/host verification flow; do not add a second web identity
or a ticket-only login. Keep the ticket visible while verification is pending.
A generic browser-authorization confirmation is not a contact approval. After it
succeeds, return to that card with the selected choice retained and require the
explicit **Continue** / **Always allow** / **Decline** decision. No automatic delayed
execution merely because a browser became verified. Recheck the ticket and role;
if it expired or changed, show the outcome in place. “One card” means one place to
finish, not pretending the verification gesture also approved hidden work.

Native General may propose and post the same exact ticket. Only a platform-verified
current administrator's button decides; General never approves itself. Use the
actual callback actor and the correct posting bot. Duplicate clicks, multiple
browser tabs and native/web races yield the same decided outcome.

No ordinary recovery asks the person to clear an Agent's origin, copy an id,
retype a request or navigate to another settings page. Permissions still lists
optional grants and audit history. Remove Clear retained origin as a permission
escape once this engine is active; retain its old audit as history.

## 7. M-3661 integration

M-3661 remains the approved special case, not a second contact engine. It is not
independent of this design's context contract, so first implement the shared
server-owned context/turn binding, then integrate its labelled pass-through once.
Its substantive approved R2 behavior is unchanged:

- Only a verified accepted Hub actor and actual answer/continuation turn may use
  the allowed `send_to_instance` path. The canonical escaped header says whose
  request this is, gives authority **none**, and warns that a reply may be shown
  to that Hub person. The receiver shares only what it would give that person
  directly. IDs/kind are structured metadata, not a user-written label.
- Freeze identity before the accepted question becomes unreadable; historical
  lookup proves identity, not a live turn/consent lease. Bind active scope to the
  current daemon boot and actual input, not the old 30-minute contact window.
- Receivers' in-turn sends and exact report continuations keep the label. A late
  result stays labelled but does not reopen the original Hub turn. Completed work
  does not label the receiver's unrelated future work.
- Refuse `forwards`, `steer=true`, `delegate_task`, broadcast, and durable task,
  schedule, instance/config/web-settings mutations until their approved context
  contract exists. Give broadcast its own clear refusal. Read-only queries stay.
- The real contact admission/ticket/grant path preserves labels through any hold
  and approval rebuild. Configured receiver-side and existing target restrictions
  still apply; there is no blanket “Hub exception” that skips them.
- Room pass-through requires the merged negotiated room-asker proof, exact
  destination/incarnation and actor kind. A missing/legacy/expired retained
  identity snapshot fails this operation closed; never use `onBehalfOf`, an owner,
  display name, body or correlation id as identity.
- General/coordinators receive the explicit rule: Hub requester provenance is
  never owner authority for instance/config/settings actions. Put this in fleet
  instructions and skills, not the small MCP core.

The approved R2 preservation of pre-existing retained origins becomes a migration
compatibility input below, not a permanent second permission union. Until cutover,
M-3661 must not drop today's independent origin gate. After cutover, preserve any
*captured active legacy request* as a legacy request context; do not keep reading
the old instance row for every future send.

## 8. Migration, peers and rollback

Rollout requires a supported transition; no automatic DB repair or inferred
administrator ownership of old outside content.

1. **Prepare without behavior change.** Add a versioned context companion and
   exact operation binding while the old engine still governs. Negotiate support
   on daemon/native/Windows hops. Prove duplicates, crash boundaries and rollback
   before enabling. Do not put new fields into strict old Hub journal JSON.
2. **Snapshot existing work.** Preserve every pending ticket's immutable original
   request and decision; no automatic admission, rejection or re-created ticket.
   For already-active/queued outside work with a known parent, capture that
   request's provenance. Unattributed active legacy work gets one explicit legacy
   context, with a card for its next affected operation. Do not assign all future
   administrator work to it.
3. **Cut over at verified input boundaries.** Fence current boot/turn and reconcile
   outstanding admissions. A later administrator message is not an erasure proof.
   Existing `contact_auth_origins` rows become historical, not permission state.
   They are not rewritten to “admin”, deleted, or spread to targets. Independent
   new administrator requests use the new identity/context path.
4. **Keep contracts.** Existing grants retain exact bounds/expiry/use counts and
   both incarnations; re-evaluate current grant-manager rights. Existing approved
   operations remain idempotent; pending/expired/declined requests are not replayed.
   Existing Clear-origin audit entries remain readable, but cannot declassify a
   captured request snapshot or approve an old ticket.
5. **Older peers/backends.** No capability means no external context delivery that
   could silently lose metadata or bypass derived-work checks. Hold the exact
   affected operation with an upgrade reason. Native CLI guard coverage is a
   different capability and must not stand in for provenance support. Supporting
   an ordinary administrator request does not imply support for outside work.
6. **Rollback.** First disable admission of new scoped outside work, then drain or
   explicitly cancel/decline versioned operations, preserving notices and audit.
   Only after no new-format work can execute may an older binary start. Preserve
   old origin rows and old ticket schemas for its conservative behavior; do not
   mirror new contexts into the old lifetime union. An unsupported direct downgrade
   while scoped work is pending is not safe or supported. A bridge/min-version
   startup guard must land before the feature is enabled. Backups are taken while
   the outbox is quiescent; never restore a live DB over accepted work.

A migration with unresolved source/incarnation or context mismatch stops that
operation and explains the conflict. It must not guess an owner, silently discard
a pending request, or reset an Agent's whole history to escape the mismatch.

## 9. Threats and acceptance controls

| Named threat | Required control / proof |
| --- | --- |
| One misclassified message locks an Agent forever | Permission lookup never reads the lifetime origin union; independent admin-root positive after completed outside work |
| Later admin input launders an unfinished outside request | Same-context steering and pending child/report retain immutable actors; no latest-speaker overwrite |
| Agent invents a person or context | Real receipt/Hub proof; body/header/tool/correlation spoof negatives |
| Free intermediary launders guest/Hub work | Ingress/context precedence is retained across routing; Free is not a label eraser |
| Login verification silently executes an approval | Same card, final explicit decision; verification-only and expiry/race negatives |
| Approval applies to different bytes, recipient or incarnation | Exact operation hash, current source/target, transactional once-only admission |
| Approval acquires owner action authority | Contact endorsement separate from human go-ahead; receiver result-audience warning |
| Wrong bot elevates or misroutes a person | Platform-qualified identity, current central admin gate, original adapter callback/send binding |
| Timer/restart washes an active Hub request | Actual turn/boot fencing, no elapsed-window release, late report keeps context without reviving turn |
| Old peer ignores provenance | Negotiated capability, missing/unknown version refusal, supported downgrade barrier |
| Durable work escapes its parent's scope | Task/notice/schedule/native-await context snapshots; unsupported derivative creation refused |
| Card races or lost ACK resend a message | One ticket across projections; atomic outbox admission; operation-id conflict/idempotency; no agent retry |

Tests are synthetic. No live approval, credential, vendor or model call is needed
to establish these contracts. User-visible build changes will need real-app/native
payload evidence and a user look; this design adds no drawn UI or runtime code.

## 10. Review decisions and build split

Before implementation, Lumen, agy, GrokCore and Prism review the entire matrix,
not just the currently failing ingress. Each finding will be mapped to a document
line/decision or an explicit deferred item. The user approves that revision.

Review specifically: (a) guest/Hub precedence over a Free intermediary, (b) what
counts as an independently admitted administrator request in a shared CLI history,
(c) one-card verification with an explicit post-verification decision, (d) M-3384
endorsement versus M-3661 unendorsed label propagation, and (e) a real downgrade
barrier rather than an old binary ignoring a new JSON field.

Proposed build cards only after that approval:

1. Versioned identity/context/operation contracts, supported peer negotiation and
   rollback barrier; shadow capture under unchanged old enforcement.
2. Actual-input/turn and durable continuation binding, central contact decision
   from request context, migration and once-only old-ticket handling.
3. Integrate M-3661 R2 on that shared contract, including receiver/return audience,
   side-effect refusals, room proof and native/Windows coverage.
4. One ticket across source chat, General and Needs you, scoped pre-verification
   read plus inline verification and explicit decision; optional grants and audit.
5. Approved cutover, scenario fixtures across the full matrix, user-look evidence
   and rollback rehearsal. Release/deployment remains a separate go-ahead.

Do not create build cards or implement these merely because this draft exists.

## Appendix: approved proposal input

The following normative excerpt is copied from the merged proposal approved on
2026-11-25. Incident-specific background is omitted from this public design; the
policy and stated reviewer differences are preserved.

> 1. One identity. A person is platform + user id; the adapter is only transport. The host operator counts as an admin. A signed-in admin web session is that admin: being recognised as yourself doesn't need verification. Verification is needed only for a go-ahead or an approval. (All four.)
> 2. Judge each request, not the agent's lifetime. Cut the per-agent "unknown/mixed" union as a permission switch, and cut copying it onto every agent that receives a message. A request started by the admin proceeds. A request started by someone else (a restricted-room member, a Hub asker, a guest) carries that scope along with what it delegates. Keep the history for explanation only. (All four; agy keeps a single simple reason, and Prism keeps request-scoped propagation.)
> 3. Where non-admin requests stop. Restricted rooms, guests and the Hub answer turn: a non-admin's cross-agent send waits for one approval. Free rooms don't hold. Lumen would deliver these labelled ("on behalf of X") instead of holding them; Prism, GrokCore and agy keep the hold. Recommendation: keep the hold (safer); labelled pass-through only inside the Hub answer turn (M-3661, already approved).
> 4. Hub. Keep the answer-turn block (already turn-scoped in beta.22), checked by the same outbound rule. Never treat "30 minutes passed" as proof the work ended. (Prism, GrokCore, agy.)
> 5. Keep the safety core. Tickets bind to the exact operation; approval and delivery are atomic, happen once, and are checked against current admins and agent generations. "Always allow" becomes an optional button, not mandatory upkeep. (Prism, GrokCore.)
> 6. Don't let one admin message "clean" outside input. Instructions an outsider already put into an agent's context stay outside instructions. Recover by approving the specific request, not by a blanket "clear origin". (Prism; differs from Lumen's "next admin message releases".)
>
> Every hold posts one card next to the held send, in the agent's own chat, in General (Discord/Telegram) and in Needs you on every link: who → whom, the exact message, the concrete reason, and Continue (approve once) / Always allow / Decline.
>
> If the browser isn't verified, the same card verifies inline and then resumes the decision; no hunting for an id.
>
> The requesting agent is told the outcome (approved by whom, delivered) and can check its own requests.
>
> No reset, no retyping, no copying an id, no navigating to Fleet › Permissions.
