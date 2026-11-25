# Slice I: same-card contact API contract

S-227, from release/2.3.5-alpha `1ecd6c97a` (includes F squash `8b095826b`).
Design first, for Fable's boundary review. J (S-228) and K (S-229) may build
fixtures against the version-1 shape below. I changes no renderer. The new
service/route host remains uninstalled in production until L; no activation,
live migration, replay, provider/account call or native posting is performed.

Parent policy: [request-scoped contact provenance §6](request-scoped-contact-provenance.md#6-one-card-and-inline-verification).

## 1. Source-boundary findings

Today contact-auth-api.ts requires verified contactActor even for reads, and
Needs you gives an unverified admin only a count. contactSuggestionActor is a
reminder-only identity, not a decision permit. Reuse admitted SessionRecord plus
FleetManager.webSessionIdentity for the new read identity; never accept an actor
from a header, body, name, tier alone or client-supplied person key.

E's RequestContactGate.decide already owns the scoped policy revision and exact
companion transaction. Legacy ContactAuthService.decide must not receive a scoped
ticket. New card reads must validate E's stored companion through its owner,
without re-deriving a context from retained origin or correlation. A shared
service presents legacy and scoped records but chooses the writer from the
stored record, never a client engine field, and never falls back after a scoped
refusal. Legacy unresolved input remains F's cutover blocker.

## 2. Version-1 presentation (shared by J and K)

Export types in src/request-contact-types.ts and server service in
src/request-contact-card.ts. Native K uses the same service and expected image;
its callback actor is resolved by the platform, not by General's tool arguments.

```ts
type RequestContactCardV1 = {
  version: 1;
  engine: 'legacy' | 'request-v1';
  ticket: { id: string; revision: number;
    state: 'pending'|'approved'|'delivered'|'declined'|'expired'|'unknown';
    source: string; target: string; verb: string;
    message: string; createdAt: string; expiresAt: string;
    decidedAt?: string; deliveryId?: string };
  sourceLabel: string; targetLabel: string;
  requester: RequestContextActorV1 | null;
  ingress: 'owner'|'free-room'|'restricted-room'|'guest'|'hub'|'legacy';
  sourceAudience: RequestContextAudienceV1 | null;
  returnAudience: RequestContextAudienceV1 | null;
  grantCandidates: Array<{key:string;label:string;platform:'discord'|'telegram'|'host'}>;
  reason: string;
  continuedFrom?: string; // rootApprovalTicketId, informational; no actions on continued outcomes
  approvalScope: 'root-request' | 'operation';
  authority: 'none';
  snapshot: { ticketRevision: number; policyRevision: number;
    imageSha256: string };
  actions: { canDecide: boolean; canGrant: boolean;
    requiresVerification: boolean };
};
type RequestContactCardPageV1 = {
  version: 1; items: RequestContactCardV1[]; nextCursor: string|null;
};
```

Actor and audience types are the existing strict request-context-protocol.ts
shapes. Labels are server-resolved display labels, escaped by the renderer.
`requester` is the recorded initiating actor, never the approver or a later admin
steer. Legacy records without one unambiguous person use null, not an invented
person. grantCandidates is the server-owned selectable known-person list (empty
when unsupported); personKeys selects only its keys, never names typed by the user. No raw human receipt/forward ids, session handle, authorization material,
full private file paths or internal pending-grant bearer data is projected.
`authority: none` describes the request, even after an admin continues it.

`imageSha256` covers the complete server-owned stored operation/admission image,
including files/forwards and context binding where present. It is not the legacy
requestHash (which omits fields), a permission, or a client-selected parent.
I validates it inside the actual decision transaction. Public presentation may
be smaller than that immutable image; a renderer must not imply the digest alone
explains an attachment's contents. I exposes existing safe displayable message
content only; attachment preview/download keeps its existing authorization path.

The root-request scope means Continue releases this request's onward contacts,
not unrelated requests or Agent side effects. Legacy operation scope retains its
old decision semantics. J and K must use this field, not infer scope from names.

## 3. Web transport (new namespace; old API unchanged while OFF)

- GET /ui/api/request-contact-authorizations?agent=…&status=…&cursor=…
  returns RequestContactCardPageV1. Default pending; bounded 32/page, max64.
  Filter after target-role scoping; cursor binds the identity/filter AND target-role revision snapshot. A role-revision change invalidates the cursor.
  No person identity selector is accepted from the client in this first version.
- GET /ui/api/request-contact-authorizations/R<uuid> returns one card.
- POST /ui/api/request-contact-authorizations/R<uuid>/decision accepts:

```ts
{ snapshot: {ticketRevision:number, policyRevision:number, imageSha256:string},
  decision: 'approve-once'|'decline',
  grant?: ContactTicketDecision['grant'] }
```

Always allow is approve-once plus the existing strict grant object. Do not rename
its fields; grant.personKeys remains the server-owned-known-person selection,
not an origin supplied by the browser. Preserve existing multi-person selection
for legacy tickets; never infer people from unknown/non-human roots.

A fresh decision succeeds with HTTP200 and the fresh card. A duplicate/stale
decision returns409 already-decided; re-read this same card to see the committed
outcome. Reuse the existing transactional decision semantics, not a second
decision-replay ledger. The response does not claim the recipient finished
its task: approved/queued and delivered are distinct from task completion.

Errors are `{error:<stable-code>}`: 400 invalid-request/invalid-grant,
401 sign-in-required, 403 forbidden or verification-required,
404 not-found (also for a ticket outside the person's readable scope),
409 conflict/policy-conflict/operation-conflict/expired/already-decided/
stale-generation, 503 unavailable. Dormant/uninstalled host returns404 without
an inventory. Denials must not return hidden ticket text, counts or person ids.
No automatic retry of a decision after any failure or unknown network outcome;
read the same ticket to inspect the result.

Both read/write paths work over localhost and named/quick links with the same
admitted-session, CSRF, current-link and continuation checks. Route-list and
link-parity tests are part of I. No new localhost-only exception.

## 4. Read identity and permission

An admitted signed-in admin session must have a recognized account/host identity,
not merely tier admin. Normalize platform + userId to PersonKey; adapter remains
transport. Require current target canManage/central administrator rights and the
stored current target incarnation. No unsigned, guest, read-only, unrelated-admin,
header-token or accountless approved-device access to full cards.

Read authority is intentionally separate from decision authority. A recognized
unverified managing admin gets the same scoped message, requester, reason,
expiry and snapshot, but actions.canDecide=false and requiresVerification=true.
Recheck the session/account and current role after any awaited read and again
immediately before serializing. A revoked role loses access; listing silently
omits inaccessible tickets without leaking their count. Do not broaden the old
Permissions endpoint or count-only legacy projection while the new host is OFF.

Verified canDecide additionally respects current eligible approver policy. A
manager who is not an eligible approver can read, but cannot decide. canGrant is
true only where an actual existing grant identity can be represented. In
particular the present ContactPerson schema has no Hub platform: a Hub actor's
verified display name/id must never be mapped to a native person. Default
canGrant=false for that unsupported grant shape; known native-person grants use
E's existing creator/current-manager checks. This representation seam is flagged
for Fable, not silently broadened by I.

## 5. Verify and resume the same card (J)

Use existing GET/POST /ui/authorization. No new ticket login, authority receipt,
resume token, or stored pending decision. The UI retains ticket id and choice
locally while authorizing this same browser. Authorization POST only requests
browser authorization; its eventual confirmation never decides a contact.

After successful browser verification, GET the same card again. If current and
still pending, show the retained choice with neutral focus and require an
explicit Continue / Always allow / Decline click. Never put a decision POST in
an authorization completion callback, effect, poll or keydown. If the ticket
changed, show its outcome in place. Signing in as a different person discards
the local choice and re-reads. No hidden selected action auto-runs.

## 6. Decision/CAS and native seam (K)

At request arrival capture the admitted session/account, not a model actor. After
bounded body read re-evaluate the same session, PersonKey, current verified
actor, target manager/approver rights, link and CSRF/continuation permit. Then the
writer's SQLite transaction rechecks ticket revision, policy revision, full image
digest, exact source/target incarnations, current request/Hub constraints and
actor authority. E owns scoped decisions and D1; legacy owns legacy decisions.
All identity/role checks are fresh predicates at the actual transaction boundary.
No get-before-await check substitutes for CAS or current permissions.

Native K uses ordinary scoped read/list when it has a server-resolved platform
actor. Its separate internal prepareForNativePost(id, currentGeneralPostingOwner)
port may prepare a proposal under the existing General-only read/posting
permission; it returns canDecide=false and never supplies a human actor. The
posting owner is a trusted current role/incarnation/destination predicate, never
a boolean or identity from tool arguments. K calls decide with the posted card's
snapshot plus the actual verified callback actor. General can
propose/post, never approve. Bind posting/confirmation nonce to the exact ticket,
snapshot, allowed choice and target/incarnations; stale, forwarded, other-person,
wrong-bot or replayed callbacks must not reinterpret a proposal. Existing native
posting/receipt machinery remains K's owner. I's core writer is shared so web and
native clicks racing produce one admission, grant use, audit and outcome.

A stale or duplicate decision is409. GET then reads the already committed
outcome without another admission/notice/grant; it never acquires fresh authority.
After revocation even an exact retry cannot read a hidden card. A request left
pending by interrupted authorization remains pending, not silently declined.

## 7. Delivery, rollout and boundary review

I will expose optional route/service ports and actual store-bound adapters with
synthetic tests. No production host installs them before L, and no admission
engine is enabled. J/K can consume frozen V1 fixtures and the above optional
transport; do not replace old renderers/posters until their own reviewed gate and
L's activation. No captures belong to I; J/K require real-app/native user look.

Acceptance: pre-verification current-manager full-card read, foreign-account and
role-revocation negatives, awaited read/body races, verification never dispatches,
explicit resumed choice, full ticket/policy/image CAS, duplicate/native-web race,
request/legacy writer fences, unknown/Hub grant refusal, public-link/CSRF parity,
OFF inertness and constructor-bypassing fixture compatibility.

Fable source-boundary questions before implementation review: identify the safest
existing live-session identity/authorization read for both targets and links;
confirm the E companion read and full-image CAS remain inside its owner; confirm
409 plus same-card GET for duplicate decisions, the General-only proposal reader
separate from human read/decision, and the unsupported Hub-person grant shape.
These questions do not authorize a broader grant schema or a live activation.


## 8. Fable design-review dispositions

- Read resolver: evaluateWebRequest(touch:false), admitted admin session and
  webSessionIdentity; current target contactAdminOf/canManage before and after
  every await/serialization. Decisions still require contactActor/webAuthority
  with actual gateway/peer. session_handle is never projected. Host-tier on a
  chat Fleet without a recognized identity intentionally remains unreadable,
  preserving M-3713's deliberate edge; use a bound native account. This never
  infers an operator merely from tier. Recognized web-only host/TOTP and native
  platform host operators use the existing central operator gate.
- E exports a validated companion read and checks expected imageSha256 inside
  its existing decide transaction. Legacy compares the digest of full stored
  request_json and policy revision inside the same transaction as store.decide.
- Duplicate/stale POST is409 followed by scoped GET, with no state in the error.
  J/K render already-decided/expired as outcome-and-refresh, not a failed action
  to retry. No extra replay ledger or optional200 replay shortcut.
- Native proposal destination is the target's server-selected managing-admin
  General topic/admin DM, never the source room or tool arguments. Text comes
  from the server card. K pins platform interaction user, posting adapter/bot,
  message id and nonce (ticket/snapshot/choice/target/incarnations); wrong-bot or
  forwarded callbacks refuse before the shared writer. I exposes no model actor.
- Continued D1 tickets expose continuedFrom and no decision actions. The cursor
  additionally binds the current role revision. Tests include sibling-bot reads,
  the deliberate host-tier/chat-Fleet denial, and K's real wrong-bot/forwarded
  callback boundary against the shared writer (platform transport belongs to K).
- Grant clarification resolved with Fable: representability only. Reuse E.person
  for native identities, including a guest request whose initiating native person
  is representable. Do not add an I-only guest-ingress exclusion or change E's
  automatic grants. Hub/unknown/non-human or account actors with no mapped native
  person remain unsupported. Legacy multi-person candidates keep explicit keys.
