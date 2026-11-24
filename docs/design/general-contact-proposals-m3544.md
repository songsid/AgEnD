# General contact-change proposals (S-217)

This implements the approved optional chat path in `contact-standing-grants-m3544.md` §7 after S-216. General proposes; a system-owned Discord/Telegram card asks a current target administrator or configured approver to confirm. No model call applies a proposal. The user look remains a separate hold before merge.

## Tool and route

`propose_contact_change` accepts `{change: ...}` with one strict variant:

| Kind | Fields | Effect after confirmation |
|---|---|---|
| `mode` | target, mode, optional revision | Existing Classic room restricted/legacy writer |
| `ticket-decision` | full ticket_id, decision, optional revision/grant | Existing approve-once/decline transaction; an optional grant contains exact originating-person keys, expiry and uses |
| `grant-adjust` | target, grant_id, expires_at, remaining_uses, optional revision | Adjust only expiry/use count, preserving the saved person/source/target/verbs |
| `grant-revoke` | target, grant_id, optional revision | Remove the chosen saved rule |

The server freezes omitted revisions from current durable state. Explicit revisions must match. It resolves the target's authoritative adapter and exactly one reachable General on that adapter. Host-only targets, missing/ambiguous platform routes and unavailable identities use the web instead. This tool is offered in General's default profile, with an independent configured-General check on raw outbound admission and the daemon method. It does not add tools to workers/coordinators or broaden other configuration permissions.

No actor, receipt, approval flag or executable action is accepted in arguments. Tool responses report only that a confirmation is waiting, without returning a nonce or leaking the held request's private content. A card shows display names, short request IDs, the source/target/request type, selected people's names/platforms and a Fleet-local expiry; structured payload evidence retains fake internal identifiers for test reproducibility.

## Named threats and controls

| Threat | Control |
|---|---|
| Agent self-approval or a quoted claim of consent | Tool admission only prepares/posts; platform callback supplies the actor; no web mirror; bot identity refused |
| Same user ID on another bot/adapter, copied or moved button | Existing 128-bit nonce binds canonical adapter, chat, thread and message; no confirmation before canonical message delivery is known |
| Stale edit overriding revocation, same-name replacement or changed route | Current target authority, policy/ticket revision, both contact incarnations, General daemon/lifecycle and route identity rechecked before synchronous apply |
| Duplicate callbacks or restart-orphaned buttons | Existing nonce claim before any await; memory-only entries expire and disappear on restart |
| Delayed timers extending approval validity | Separate monotonic five-minute deadline; posting has a five-second budget and late delivery is retired |
| Prompt flooding | At most eight outstanding proposals per requesting General and 64 overall |
| Standing grant widening or person spoofing | Reuse server-owned ticket origin subset and existing exact matcher; unknown origins cannot create rules; adjust does not change scope |
| Hub contact-limit bypass | Hub restriction checked before posting and before applying; existing decision service enforces M-3160 again |

Mode changes use `contactAdminOf`; rule changes use `canManage`; ticket decisions use `canDecide`, including its configured-approver list. The actor is derived from the current receiving platform adapter and callback user. The saved audit actor is that person, never General. No new administrator role or web auth scope is introduced.

## Lifecycle, outcomes and limits

Changing mode or rules uses the existing permission writer; ticket decision, optional rules and durable admission retain the existing SQLite transaction. Cancellation and expiry do not change permissions. A stale card closes with an expired/changed notice. A failed application says its outcome could not be confirmed and asks the person to inspect current state before retrying, because existing mode persistence also spans the Classic configuration file. This feature does not add a cross-file transaction or automatic retry.

Contact approval authorizes forwarding only. It does not approve or isolate the receiving agent's later actions. M-3384 endorsement still leaves the receiver's origin unchanged. General cannot use this path to change room tools, approvers or a rule's person/source/target/verbs. The existing web remains available for those operations.

## User look and rollback

`docs/evidence/general-contact-proposals-m3544/{en,zh-TW}.json` records the actual private nonce posting/callback/timer paths against a synthetic adapter, including posted cards, buttons and all outcomes. No platform sign-in, visible window, live Fleet or provider call is used. Only the ephemeral test nonce is redacted. This is native text/payload evidence, not a drawn UI or a claim about platform rendering.

No schema migration. Revert the tool and callback integration to remove this entry point; existing web permissions, durable grants and tickets continue to work. Old in-memory proposals are inert after restart. Rollback must not replay a proposal or use a stale nonce as authority.
