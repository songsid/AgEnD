# Request-scoped contact provenance

Status: R3. The user chose D1 option (2), request-scoped onward release, on
2026-11-25. The complete design still awaits final approval. No product implementation;
implementation also waits for the beta.23 merge freeze to lift.
Source baseline: `8052c59ee292740b4234c263be47ee95dd27e4fb` on
`release/2.3.5-alpha`. This follows the user-approved two-phase contact-lock
simplification. Phase 1 preserves signed-in account identity separately from
approval authority. This document proposes Phase 2.

## 1. Policy and limits

A contact decision starts with an exact held operation and belongs to its request,
not to an Agent's lifetime. Remove the accumulated per-Agent `unknown`/`mixed` origin as a permission
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
6. A later administrator message never cleans a tracked operation of an existing outside request. A
   person approves the displayed request and its onward contacts, as decided in D1;
   there is no blanket origin reset.

Contact permission is permission to deliver a message. It does not approve the
receiving Agent's actions, confer the owner's authority, or grant credentials.
**User decision D1 — option (2), “one press releases the rest”:** when a managing
administrator presses Continue on outside request A→B, the same request's onward
contacts B→C and later hops do not ask for contact approval again. This retains
M-3384's ordinary onward-release behavior, now bounded by an explicit request
identity instead of lifetime Agent state. GrokCore's stricter per-hop approval
preference was considered and **declined by the user** on 2026-11-25.

The first approved operation still binds exact bytes, source/target incarnations
and current administrator proof. Its committed ticket then supplies the
request-scoped onward endorsement. Every later operation has its own immutable
payload/idempotency/currentness checks, but does not create another approval just
because it is another hop. The source actors, ingress, audience and labels remain
unchanged. Hub provenance, `authority: none`, side-effect refusals and the old-peer
barrier are never removed by Continue.

Only that request's mechanically linked descendants and continuations use this
release. A new outside request starts unendorsed and needs its own first decision,
unless a separately configured standing grant matches. Neither the same person,
room, Agent, conversation history nor a later unrelated request inherits D1.
Nothing marks a receiving Agent restricted or authorized for life, and Continue
does not approve the receiving Agent's actions or create a general human go-ahead.

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

Proposed server-owned records (a **tree**, not a provenance DAG):

```text
RequestContext
  id, rootContextId, rootReceiptOrAcceptedHubDeliveryId, parentContextId?  # zero or one
  initiatingActor                    # immutable normalized id/kind, or unknown
  ingress                            # owner / free-room / restricted-room / guest / hub
  sourceInstance + incarnation
  sourceAudience
  requestApprovalTicketId?             # on the root only; reference to existing committed decision
  returnAudience?                    # only if different, especially Hub

TurnBinding
  contextId, daemonBoot, ownedInputOrLogicalTurnId
  state                              # active / ended; never awaiting-children

OperationContext
  operationId, source + target incarnations, actual tool verb
  contextId + payload digest
  ticketId?                          # initial hold/grant decision; later same-request hops need no new ticket
```

Do not persist a second `contactPolicy` enum. Derive the decision from immutable
ingress, real tool, the root's committed approval or a current matching grant,
and the exact operation/ticket. Existing outbox and
reply-obligation states track pending/terminal work; there is no new agent-wide
“awaiting children” lock.

**Ingress precedence:** `hub > guest > restricted-room > free-room > owner`.
This selects the most restrictive applicable authenticated ingress fact; an
owner's new root has no outside fact. For native/admin inputs the room-restricted fact
only applies to a non-admin; it does not override an administrator merely because
the room mode is restricted. Once admitted, descendants cannot downgrade
it. An administrator steer of outside work remains that work, rather than
re-running ingress selection as `owner`. Hub proof/kind and its side-effect
constraints survive any target-side contact approval. D1 is a separate release
of the contact-approval requirement, not a downgrade to `owner` or `free-room`.

Initially refuse multi-parent derivatives. Do not select one convenient parent,
union people, intersect/union audiences, or apply one request's approval to
unrelated parents. A multiwriter board wake must be split into separate provable inputs,
one parent each, or refused before writing the pane. Reordering contributors or
retrying cannot turn it into normal work. Durable board/schedule derivative
creation from outside work remains refused in the first build; it is not a reason
to build a general graph engine now.

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

The first Continue commits the exact held operation and the root's
`requestApprovalTicketId` in the same admission/audit transaction. A matching
administrator-written standing grant has the same request-scoped effect; its
normal use is consumed for the initial admission, not again for every descendant.
This reference reuses the existing decision, not a second approval workflow.
The approved request has no new arbitrary 30-minute onward-release timeout:
pending-ticket expiry governs the unmade decision, not whether admitted work
silently loses its request identity. Retain the ticket/root binding while any
tracked child or recovery can still use it.

For a later operation, follow only the server-owned root/parent/obligation binding;
verify that its referenced decision is committed for that root and has not been
invalidated by the supported lifecycle. Never accept an Agent's claimed root,
header, ticket id or correlation as endorsement. Only a proven durable commit
establishes the release. An uncommitted/rolled-back transaction does not; a lost
network ACK neither manufactures nor erases a committed root decision. Uncertain
physical delivery follows the existing outbox reconciliation, never a blind resend. Source/target
incarnation, actual caller/turn, tool, audience and peer-capability checks still
run for each operation. Their refusal is not a demand to approve the same request
again and must name the actual cause.

The admitted payload already contains the escaped informational label and return
warning; the companion is for machine enforcement, not the sole place the label
exists. An old renderer cannot turn these stored bytes into an unlabelled message.
This does **not** make an old binary safe to execute the work: the downgrade
barrier below is still required.

The receiving binding retains the immutable actor, ingress and audience even
after Continue. In particular, approving a held Hub relay preserves Hub
provenance, `authority: none`, and every M-3661 side-effect refusal. Its same-request
onward contact does not ask again under D1, but still has to be a permitted real
tool under those Hub rules. No contact endorsement exempts it from a Hub tool or
side-effect refusal. No lifetime origin or permission switch is copied to the
receiver. A later independent root has neither the old label nor its D1 release.

A reply on an exactly matched obligation uses the existing approved-return path
without a second contact application, limited to that obligation's recipient and
audience. The label and audience warning still travel. It is not permission for an
unrelated peer contact or a new human go-ahead. Existing incarnation and
delivery checks remain. A target that also speaks in a Free room cannot publish a
guest/Hub reply into that wider room merely because the target's normal output
route points there.

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
| Ordinary Fleet work | Continuation of restricted/guest/Hub work | Any later administrator message | Retain its scope and committed D1 release, if any | Before the first approval it stays held; after Continue its onward contacts do not ask again; administrator text itself changes neither |
| Ordinary Fleet topic/DM | Native non-admin admitted by existing access rules | Identified, verified or not | **No contact hold**, unless this is a tracked restricted/guest/Hub continuation | No owner action authority; this follows the approved “holds only in those three modes” rule |
| Ordinary Fleet work | Agent or system-started input | Proven independent assignment, not recovery/resume | Normal only with an admitted independent root | A recovery/resume/wake follows the mechanical rules below; “system” is not trusted-root evidence |

The two “either room mode” rows describe a different authenticated ingress, not
someone speaking as a Free-room member. A guest or Hub request cannot become
Free-room work simply by selecting a target whose own room mode is Free.
The four reviews support retaining this ingress precedence. Under the user's D1
choice it continues to label and constrain the next hop after Continue, while the
request's contact-approval requirement is released. Native non-admin
Fleet-topic work is explicitly unheld: that is a conscious relaxation of any
accumulated-history restriction, not an accidental omission. The user approves
this matrix, including D1, before implementation.

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
   owned input/turn. Apply the mechanical table below, never the meaning of the
   text. While an outside context owns the active turn, **every input accepted
   into that turn inherits it**. An independent administrator root starts only
   after that binding ends. A displayed idle pane with an unresolved active
   binding is not proof that it ended. No “latest speaker wins”.
3. **Create a contact operation.** Snapshot actual tool verb, bytes/files, target,
   both incarnations and context before delivery. First check the server-owned
   root's committed D1 release. If present, admit without another contact ticket
   while retaining all other checks. Otherwise match a grant deterministically
   or create exactly one immutable ticket. A changed retry conflicts.
   If several new-engine operations of that **proven same root** already wait,
   the first Continue queues their re-evaluation under D1 without another human
   approval. Their exact hashes, currentness and once-only admissions still hold.
   It never replays terminal/declined/expired operations or unrelated old tickets;
   legacy tickets without provable common roots are not grouped by inference.
4. **Hold.** One durable ticket is projected next to the held send, in the source
   chat, General on Discord/Telegram, and Needs you on every link. These are views
   of the same ticket, not four independent applications. Pending delivery is not
   retried by the agent.
5. **Decide.** Re-read current target managing administrator/approver, ticket and
   policy revisions, expiry and both incarnations. Commit approval/grant-use/audit
   and outbox admission plus the root's D1 reference atomically. Decline/expiry
   never dispatch or endorse that root. A timer/sweep
   sends the existing once-only status notice; approved notices distinguish queued,
   delivered and unconfirmed. Status messages contain no new authority.
6. **Continue.** The first approval releases contact approval for the same request
   and its later hops under the user's D1 choice, while retaining label/scope. M-3661 relays do the same through receiving turns and
   exact returns, with their specific pass-through/refusal rules. A permitted
   resume or wake uses its immutable parent. Outside board/schedule creation is
   refused in the initial build; existing wakes are never assumed normal merely
   because the system generated them. No continuation revives a finished Hub
   answer turn or its lease.
7. **End.** A real owned turn end, explicit cancellation or fresh-runtime boundary
   retires the *active binding*. Awaited children retain immutable work records.
   A later exactly matched report starts its own scoped continuation. A child
   cannot become normal merely because the parent stopped being active. Pending
   tickets/children do not lock unrelated new input after the active binding ends;
   they also never replay merely because a new administrator root started.
8. **Recover after crash.** Reconcile the current daemon boot/turn and durable
   admission/obligation records. An unknown active state blocks that work from
   dispatch, with its card explaining Continue or Decline; it does not install a
   new lifetime restriction on every future request. Timeouts expire applications
   or cancel work; they never convert outside work to administrator work.

### Mechanical input and continuation table

| Actual server-observed situation | Required input binding |
| --- | --- |
| Outside turn active; human input is accepted into it | Same outside context, irrespective of an administrator's wording or verification |
| Outside turn active; administrator chooses a new independent request | Queue it; admit a new root only after owned end, explicit cancel or a fresh-runtime boundary |
| Active binding ended; ordinary non-reply administrator input | New administrator root; old pending tickets/children remain untouched |
| `/steer` or native/web reply points to an existing work message | Continuation from the server's exact message/work mapping; never a parsed quote, correlation string or model-selected parent |
| Idle `/steer` lacks an unambiguous mapped context | Ask which work to continue; do not guess an owner root or silently retry a held send |
| Reply-recovery prompt | Exact recovery job's parent context; never “Agent's own work” |
| Restart/resume prompt | Restored work's parent; starting a fresh runtime ends the old active binding but does not erase the resumed work's context |
| Board wake or scheduled input with a captured parent | Same single parent, including labels and audience; outside derivative creation remains disabled until supported end to end |
| System-started resume/recovery has no trustworthy parent | Conservatively use the most recent outside context's restrictions if no independent administrator root has begun since; **do not inherit its D1 release** without a proven parent |
| No trustworthy parent and the previous rule cannot identify one | Refuse/defer that resume or wake with a concrete reason; require a deliberately new admitted request, never guess normal work |
| Several different parents contribute to one wake | Split into separate mapped inputs, or refuse the wake; never pick one parent or reuse one approval |

Each independent external message creates a new unendorsed root, even from the
same person or room. It queues while another outside turn is active; it is not
injected under that turn's approval. A server-registered expected answer/return
may continue its exact parent, and a permitted administrator steer may enter the
active context. Merely quoting an old message or replying to arbitrary history
cannot select an endorsed root. All accepted inputs within the active turn still
inherit that turn; there is no semantic “this text seems independent” override.

This table is a routing rule, not natural-language classification. Keep a bounded
server-owned recovery pointer tied to context, incarnation and work generation;
it is not the retired union and never gates a new independent administrator
request. Clear/replace that pointer only at a proven input boundary. Recovery
jobs that already name a parent cannot discard it because an administrator root
has started in the meantime. Unknown or missing metadata is not a new owner root. An
unproved recovery fallback starts distinct unendorsed recovery work, recording
the old context as diagnostic evidence only. It is not a causal parent or a claim
that the old person asked again. It may preserve conservative audience/scope
limits, but cannot borrow an old request's approval or standing grant. Genuine
mapped recovery/returns keep their proven root and its D1 release. This prevents
“resume the last thing” from authorizing unrelated new system work.

An unrelated member's message must queue as its own root rather than being
silently added as another actor under somebody else's standing grant. Only a server-registered expected
answer from that initiating actor or a managing administrator's permitted steer
can join the active context. Any other external message starts a new root and
cannot obtain the prior request's approval or person's grant. Unsupported mixed-actor joining is
refused, not handled by a new `mixed` union.

A context's evidence cannot be pruned while a ticket, obligation, recovery job or
supported child can still reference it. Retention/capacity pressure refuses only
the new affected work with a reason, not a global unknown state. A system resume
of completed outside work is a labelled continuation, never a revival of the
old active Hub turn. Existing outbox/obligation states provide these lifetimes;
no extra “awaiting-children” turn lock is introduced.

Tracking cannot infer semantic parentage from arbitrary model memory. The gates
cover the enumerated input/return/recovery edges. Until board/schedule creation
carries a single parent end to end, refuse it from outside-labelled work. This
does not confine raw shell, manually copied text or untracked scripts.

## 6. One card and inline verification

The card identifies the sending Agent and exact target, initiating person/platform,
message, return audience, concrete reason and expiry. Continue also states its D1 scope:
“Continue this request and its later Agent contacts. This does not approve what
Agents do or authorize unrelated requests.” / 「繼續這筆請求及它後續的 Agent 聯絡；
這不代表核准 Agent 的操作，也不會授權其他請求。」 Do not describe Continue as
releasing only this one A→B message. Always allow remains the separate optional
rule for future matching requests. Actions are **Continue
(approve once)** / **Always allow…** / **Decline**. Standing grants remain optional,
with the existing exact person + source room/Agent + target + verb + both
incarnations, default seven days and explicit expiry/revoke. Legacy tickets containing several people retain their existing explicit-selection
contract; new work does not join different parents to manufacture a new multi-person
scope. Unknown or non-human identity cannot become a person grant by inference.

An administrator who is signed in but unverified sees the *same scoped card* with
inline **Authorize this browser**. This intentionally replaces Phase 1's count-only
projection: recognition/current role authorize the scoped read, not the decision.
Authorize that read by the session's normalized `PersonKey` and current target
`canManage`/central administrator gate, **not** `tier === admin` alone. A role
revoked during an awaited read loses access. Do not expose full cards to unsigned
users, guests, read-only sessions or unrelated administrators. Public-link admin parity keeps the same session, CSRF, current-role
and action checks as localhost.

Use the existing account/host verification flow; do not add a second web identity
or a ticket-only login. Keep the ticket visible while verification is pending.
A generic browser-authorization confirmation is not a contact approval. After it
succeeds, return to that card with the selected choice shown but focus neutral (Enter must not fire it), and require the
explicit **Continue** / **Always allow** / **Decline** decision. No automatic delayed
execution merely because a browser became verified. Recheck the ticket and role;
if it expired or changed, show the outcome in place. “One card” means one place to
finish, not pretending the verification gesture also approved hidden work.

If an administrator's own steer is held because it entered somebody else's
active work, the card says: “This was sent while {agent} was working on {person}'s
request.” It names the original requester and exact operation, so it does not
misidentify the administrator or suggest their account stopped being recognized.

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

M-3661 does not introduce a separate relay engine. Its label and all refusal
rules remain even if a target-side delivery hold is approved. Before cutover,
today's origin gate still applies; after cutover it is replaced by the shared
request-context rule, not preserved as a second lifetime permission switch.

## 8. Migration, peers and rollback

Rollout requires a supported transition; no automatic DB repair or inferred
administrator ownership of old outside content.

1. **Prepare without behavior change.** Add a versioned context companion and
   exact operation binding while the old engine still governs. Negotiate support
   on daemon/native/Windows hops. Prove duplicates, crash boundaries and rollback
   before enabling. Do not put new fields into strict old Hub journal JSON.
2. **Carry pending operations, not old unions.** Preserve every pending ticket's
   immutable message/origin/decision and idempotency. Existing known-parent work
   can retain that single parent. Do not manufacture a “legacy context” card from
   each accumulated origin row: those rows contain the false positives this work
   removes. Start new roots without the old union. Restricted rooms remain
   restricted for their actual non-admin requests. Finish or explicitly cancel
   untracked in-flight work under the old engine before a verified cutover
   boundary; do not silently reclassify a running turn as administrator work.
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
6. **Downgrade barrier before cutover.** Do not rely on an optional companion
   version that an already-shipped executable ignores. First ship a bridge
   schema/startup barrier understood by every supported rollback target, or use
   an in-flight state/kind that those targets demonstrably refuse. The gate must
   actually run each supported old executable with pending scoped work and prove
   zero dispatch. Direct rollback to a pre-bridge release (including beta.22 and
   earlier) while Phase 2 work exists is unsupported and must fail closed through
   the storage/startup barrier. Until that proof exists, Phase 2 stays disabled.
   The escaped provenance header and audience warning are baked into admitted
   payload bytes as defense in depth, never a replacement for machine enforcement.
7. **Rollback.** First disable admission of new scoped outside work, then drain or
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
| Same request asks repeatedly after Continue | Proven A→B→C→D positive needs only the first approval; each operation still has once-only admission and immutable bytes |
| Approval leaks into another request or grants owner action authority | D1 follows only the committed root and server-owned descendants; same-person new-root, forged-root and unproved-recovery negatives, label/audience/Hub refusals remain |
| Wrong bot elevates or misroutes a person | Platform-qualified identity, current central admin gate, original adapter callback/send binding |
| Timer/restart washes an active Hub request | Actual turn/boot fencing, no elapsed-window release, late report keeps context without reviving turn |
| Old peer ignores provenance | Negotiated capability, missing/unknown version refusal, supported downgrade barrier |
| Free receiver publishes an outside reply to its whole room | Guest/Hub result after Continue stays within the captured return audience; a later independent room root remains usable |
| System-originated turn launders outside work | One negative per recovery prompt, restart/resume, board wake and schedule; exact parent or bounded outside-recovery fallback, never default Normal |
| Durable or multiwriter work escapes its parent | Single-parent tree; unsupported derivatives refused; mixed-parent and reversed-order/retry negatives, no approval shared across unrelated roots |
| Card races or lost ACK resend a message | One ticket across projections; atomic outbox admission; operation-id conflict/idempotency; no agent retry |

Tests are synthetic. No live approval, credential, vendor or model call is needed
to establish these contracts. User-visible build changes will need real-app/native
payload evidence and a user look; this design adds no drawn UI or runtime code.

## 10. Review decisions and build split

Lumen, agy, GrokCore and Prism have reviewed R1 at `31a08ccd`. Before implementation, material resolutions go back through the Leader and the user approves the final revised design. Review covers the entire matrix,
not just the currently failing ingress. Each finding will be mapped to a document
line/decision or an explicit deferred item. The user approves that revision.

Review specifically: (a) guest/Hub precedence over a Free intermediary, (b) what
counts as an independently admitted administrator request in a shared CLI history,
(c) one-card verification with an explicit post-verification decision, (d) M-3384
endorsement versus M-3661 unendorsed label propagation, and (e) a real downgrade
barrier rather than an old binary ignoring a new JSON field.

Proposed build cards only after that approval:

1. Versioned single-parent context/operation contracts, supported peer negotiation and
   rollback barrier; shadow capture under unchanged old enforcement.
2. Actual-input/turn and recovery/return binding (no multi-parent joins), central contact decision
   from request context, migration and once-only old-ticket handling.
3. Integrate M-3661 R2 on that shared contract, including receiver/return audience,
   side-effect refusals, room proof and native/Windows coverage. Board/schedule derivative creation stays deferred/refused.
4. One ticket across source chat, General and Needs you, scoped pre-verification
   read plus inline verification and explicit decision; optional grants and audit.
5. Approved cutover, scenario fixtures across the full matrix, user-look evidence
   and rollback rehearsal. Release/deployment remains a separate go-ahead.

Do not create build cards or implement these merely because this draft exists.

## 11. Four-review disposition after D1

All four independent R1 reports were read in full. These are design dispositions,
not formal implementation approvals. D1 is now resolved by the user as option
(2): one Continue releases the same request's later contacts. GrokCore's stricter
per-hop preference is recorded below as considered and declined; this is a user
policy choice, not a claim that every reviewer originally preferred it.

### agy / Gemini

Source: [independent review](https://github.com/songsid/AgEnD/pull/4456#issuecomment-7153693984).

| Point | Disposition |
| --- | --- |
| B1: idle/pending-child admin continuation versus new root | Adopted: §5 mechanical table uses active binding, exact reply/steer mapping, and idle non-reply root. Pending children never lock unrelated roots or replay on an admin message. |
| B2: approval must not strip Hub provenance/refusals | Adopted: §3 and §7 explicitly retain Hub label, authority-none and side-effect refusals through a contact approval. |
| S1: ingress precedence | Adopted: §3 states `hub > guest > restricted-room > free-room > owner`, immutable down the single-parent tree. |
| S2: pre-verification card reads require current manager identity | Adopted: §6 requires normalized PersonKey plus current target canManage/central admin gate, with awaited-role recheck; tier alone is insufficient. |
| S3: direct pre-bridge rollback ignores metadata | Adopted: §8 requires a proven schema/startup or fail-closed in-flight-kind barrier before enablement; actual old executables must dispatch zero work. |
| Cut DAG, awaiting-children lock and early durable derivatives | Adopted: one parent, active/ended binding only, outside board/schedule creation deferred/refused. |
| Do not ship M-3661 before the shared contract | Adopted: §7 and build order retain that dependency. |

### Lumen / Claude

Source: [independent review](https://github.com/songsid/AgEnD/pull/4456#issuecomment-7153697956).

| Point | Disposition |
| --- | --- |
| B1: system-started recovery/resume/wake can wash outside work | Adopted: §5 gives exact-parent binding and bounded most-recent-outside fallback when no independent admin root has started. No system input defaults to Normal. Tests enumerate recovery, restart, board and schedule. |
| Label must travel after Continue; no lifetime target taint | Adopted in §1/§3. D1 now preserves request-scoped onward release after Continue, as chosen by the user; labels and audience remain. |
| Free-room receiver may publish reply too widely | Adopted: §3 audience contract and §9 negative test forbid guest/Hub results reaching a wider room, including after approval. |
| Explain an admin steer held under outside work | Adopted: §6 card names the current Agent and original person's request; actor identity is not misreported. |
| Unify approval/label treatment | Label always survives; the user chose one approval for that request and its later contacts, not unrelated roots. Hub refusals always survive. |
| Bake label into admitted bytes for old renderers | Adopted: §3 and §8. This is defense in depth; an older binary still cannot safely execute scoped work without the barrier. |
| Drop per-origin legacy-context cards at cutover | Adopted: §8 migrates pending tickets/known-parent work, not every old union. Finish/cancel untracked active work before cutover; no mass replacement unknown cards. |
| Ordinary non-admin Fleet-topic row must say held or not | Adopted: §4 plainly says no hold for admitted ordinary native non-admin input, unless it is a tracked restricted/guest/Hub continuation. User approves this explicit matrix. |
| Wording, neutral focus and redundant state enums | Adopted: “tracked operation” wording; selected choice visible but neutral focus; remove stored contactPolicy and awaiting-children lock. |
| M-3661 needs receiving-turn binding | Adopted: shared contract first. |

### Prism / Codex

Source: [independent review](https://github.com/songsid/AgEnD/pull/4456#issuecomment-7153730549).

| Point | Disposition |
| --- | --- |
| Multiple parents lack policy/audience/endorsement join | Adopted the simpler alternative: §3/§5 refuse multi-parent derivatives, or split into separately mapped inputs. No parent is selected by order, and no request endorsement covers an unrelated root. |
| Mixed-parent and order/retry controls | Adopted in §9; repeated/reordered mixed-writer wakes remain refused, and do not become a Normal root. |
| Keep explicit verification decision and tracked-only limit | Retained in §1/§6; no claim of semantic or memory isolation. |
| Keep M-3384 ordinary endorsement distinct from unendorsed Hub | Hub constraints are preserved. The user resolved D1 in favor of same-request onward release. Unendorsed new roots still need their own first decision, while Hub provenance and constraints survive every approval. |
| Prove actual supported older executable barrier | Adopted in §8: not a version warning or optional companion field; enabling waits for zero-dispatch proof. |
| Cut lifetime union/reset and a second relay engine | Adopted; use existing operation/ticket/outbox/obligation state. |
| M-3661 can prepare disabled, not enable before shared receiver/continuation | Adopted in §7 and build split. |

### GrokCore / Grok

Source: [independent review](https://github.com/songsid/AgEnD/pull/4456#issuecomment-7153782696).

| Point | Disposition |
| --- | --- |
| Lock active-turn input inheritance mechanically | Adopted verbatim in substance in §5: every input accepted into an outside active turn inherits it; an independent root starts only after owned end/cancel/fresh-runtime boundary. |
| Prefer per-hop endorsement; re-check approval on the same request's next hop | Considered and declined by the user: D1 option (2) releases that request's later contact approvals after one Continue. Adopted the non-laundering portion: the label and audience remain, and no unrelated root inherits the release. |
| Free intermediary cannot erase guest/Hub context | Adopted at root selection, receiving admission and each derived send. |
| Same-card verification must not execute a retained choice | Retained with neutral focus and a final explicit decision in §6. |
| Old-peer refusal and supported rollback | Retained and made concrete in §8, with admitted label bytes plus actual executable barrier proof. |
| Cut extra endorsement store and unnecessary audience duplication | Adopted: ticketId references the existing decision; returnAudience is optional when source audience is sufficient. |
| Collapse verified/unverified matrix rows | Not adopted: the user's acceptance explicitly requests that cross-product. The policy is stated once; repeated rows make the unchanged contact result visible. |
| Defer Always allow | No new grant engine is proposed. Keep the existing optional grant action because the approved card choices include it; reuse it, with no mandatory maintenance or new prerequisite. |
| M-3661 waits; information-only preparation may precede | Adopted: no enabling pass-through before shared context, continuation and downgrade safety. |

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
