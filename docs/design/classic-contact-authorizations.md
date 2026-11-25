# Classic room contact authorizations

A group room can relay requests to a worker agent with broader standing permissions.
Restricted mode holds non-administrator contact requests before any worker input,
wake, forwarding grant or ordinary delivery admission. It does not authorize the
worker's subsequent shell, data access or changes. Action-scoped brokers are later work.

## Contract for the first slice

The TypeScript wire contract is `src/contact-auth-types.ts`. Dates are ISO UTC.
All routes use the dashboard's existing authenticated request and write protection.
Guest and agent-token callers cannot manage permissions or decide applications.
The server resolves actor identity; JSON actor fields never establish authority.

| Route | Result |
| --- | --- |
| GET `/ui/api/instances/:name/contact-permissions` | `ContactPermissions` |
| PUT `/ui/api/instances/:name/contact-permissions` | `ContactPermissionsWrite` → `ContactPermissions` |
| GET `/ui/api/contact-authorizations` | `ContactTicketPage`; optional agent, person, status, cursor filters |
| GET `/ui/api/contact-authorizations/:id` | `ContactTicket` |
| POST `/ui/api/contact-authorizations/:id/decision` | `ContactTicketDecision` → `ContactTicket` |

Permission reads are scoped to managers; ticket reads are scoped to approvers
and authorized source-room administrators. Lists never reveal other rooms' requests.
Writes require the observed revision; stale writes return 409. Refused identities
return 403, unavailable stores 503. Each list is bounded to 50 rows.
The person filter is an exact server-issued identity key, never a fuzzy name search.
Contact authorization identifies a person by **platform + user id**, across bot
connections on that platform. Adapter ids remain transport/proof metadata; a
second bot observing the message does not create another person or remove their
configured Fleet-admin role. Discord and Telegram ids remain separate namespaces.
Signed-in web account identity is separate from go-ahead authority. The current
session's bound account and platform are stamped by the server for typed messages,
resends, reply-button choices and commands that enter the conversation. A web-only
Fleet's explicitly identified host session is recognized as its host operator;
unbound old/device sessions and header-token requests do not become the operator.
Receipt `origin.web_identity` records recognition, while `authority` remains
unchanged (`none` until the existing verification rules pass). Display names,
message bodies, client metadata and voter keys never supply this identity.
The central current-role gate still decides whether that person manages a target.
A host sign-in on a chat-connected Fleet does not name a Discord/Telegram account,
so it is not silently substituted for one of that Fleet's administrators. Likewise,
an approved device with no bound account or explicit host/TOTP sign-in proof does
not borrow the approving browser's identity, even on a web-only Fleet. Device
approval grants dashboard access; its display-only `via` field is not identity
proof. Such browsers must sign in as the account or through the supported host
path to supply a recognizable person. Tests pin both boundaries.
**Revoke web authority** removes go-ahead authority, not the signed-in session.
That session still identifies its account for contact permissions, including its
current administrator role. To stop recognizing a lost browser as that account,
use its **Sign out** action or **Sign out everywhere**; revoking authority alone
is insufficient. Neither action guesses away existing retained origins.

Historical unverified receipts discarded their session-account join, and retained
origins can lose older receipts or include a mode-switch seed. No speculative
migration or automatic clear is possible. A verified managing administrator can
use **Permissions → Clear retained origin**, with its existing revision/generation
CAS and audit, to accept that conversation as their own work. Unknown still stays
unknown after a later known admin input; old pending applications are not replayed.
The held-contact refusal and Needs you card explicitly name the recovery action.
The optional receipt JSON field requires no schema migration; an older build may
ignore identity and conservatively treat later plain-web work as unknown again.

Contact administrator checks retain the central `isFleetAdmin`/admin gate, evaluated
against the target connection and configured connections on the same platform.
This intentionally lets a configured secondary bot's Fleet administrator manage
contact permissions on primary-bot topics: receiving through another bot must not
change the person's contact role. Other feature administrator gates are unchanged.
Runtime-only or removed connection worlds do not enlarge this configured set;
the target adapter's existing administrator lookup still applies. The existing
Classic room fallback to `defaults.admin_users` is unchanged by this work.
The target platform's configured Fleet-admin lists supply eligible approvers;
its explicit approver selection and all grant action/resource/incarnation bounds
still apply. This does not change inbound routing, outbound bot selection, or
human receipt verification.

Known historical origins that list only one person through several adapters are
read as one human origin, including after restart. Explicit unknown origins and
mixed single-person markers remain restricted; genuinely different people remain
mixed. No state-file edit is needed. Recovery never auto-approves, dispatches or
replays an old pending application: it still needs a decision. New work from a
configured admin can proceed normally. Existing grants keep their expiry/use
limits. New selector keys contain `[platform, userId]`; old three-field selector
keys are accepted with the adapter field treated only as historical metadata.

The UI may display server labels but must preserve the whole returned identity.
In slice 1 an approver must be a configured Fleet admin on the target's platform. The
verified host operator may also approve. The picker uses `eligibleApprovers`,
never arbitrary names or message-supplied identities. Non-admin approvers are
deferred; they do not receive global administrator rights through this feature.
An ordinary delegated Fleet worker without `channel_id` inherits the primary
adapter. When a target truly has no Discord/Telegram adapter, only an already
verified host operator may approve; an empty channel-approver list does not
remove that exception. Existing identity verification still applies.

An approved application binds its exact arguments, origin, source and target
generation, expiry and result recipient. Approval creates at most one durable
outbox delivery. A lost confirmation is unknown, never permission to resend.
An explicit administrator approval or a matching administrator-written standing
grant endorses that delivery: it does not merge origin into the target, including
General. The target's pre-existing origin is neither cleared nor replaced. The
source room retains its own origin; the ticket retains the original origin and
approval/grant audit. Approval is still contact permission, not permission for
later data access or effects. This rule is prospective; old inherited origins
are not silently cleared.
Broadcast creates separate applications and reports each target's outcome.
Decline and expiry each enqueue one short status-only system notice to the source
agent, naming the ticket and target. Approval emits no such CLI notice. The
existing 30-second Fleet sweep detects expiry even without a page read; startup
also sweeps retained pending work. Notice admission and its durable dedup marker
share the outbox transaction, so retries/restart cannot create another notice.
Previously terminal tickets are baselined on upgrade rather than re-announced.
The notice contains no human receipt, grant, original correlation or routing
capability, and never permits a new contact. Outbox delivery/reconciliation rules
still apply if transport becomes uncertain.
`report_result` cannot be used as an unapproved new contact. A proven return on
approved work reuses only its authorized return path, not a correlation string alone.

The topmost human origin is carried by server-owned work records across relays,
later turns, schedules, retries and restart. Mixed or unavailable origins do not
become administrator work merely because the latest message is from an admin.
The first slice conservatively stores this union per agent instance for ordinary
relays without administrator endorsement. Approved or granted deliveries are
excluded from target inheritance as described above. It is not keyed by
conversation or work item. A later direct administrator message merges into that retained history; it
does not clear earlier non-admin or unknown input. Approval allows the retained
request once; it does not clear the union. Idle and compaction never clear it.
Turning a Classic room back to legacy restores that room's outgoing behavior,
but does not remove origins from work already handed to a worker.
An observed, proven context erasure could clear the union. Today's `/clear`
acknowledgement proves handoff only, and the existing conversation-generation
counter also rotates on retained resumes. Neither is used as erasure proof here;
`resetSupported:false` describes this automatic-reset gap. An explicit verified
administrator override is now available on every agent's Permissions tab; see
[Administrator contact-origin reset](contact-origin-reset.md). It accepts the
current retained conversation as that administrator's work, with a monotonic
origin revision, incarnation/policy checks and atomic audit. It never erases CLI
text or alters frozen tickets, other agents or grants. Automatic recovery at a work-item
boundary is later work and requires a verifiable work-item close, never a guessed
correlation string or the most recent speaker.

Only an actual legacy-to-restricted switch initializes the retained origin as
unknown, because earlier CLI history has not been verified as erased. Saving an
already restricted mode does not alter its origin. Unknown origins cannot match
standing contact grants, so new contacts, including administrator contacts, need
separate approval. This is shown before switching.

Receipt identifiers and diagnostic hops are retained as the latest 64/32 entries;
trimming those lists does not change known originating people or their authority.
More than 16 distinct people still fails closed as unknown. Explicit and already
stored unknown remains unknown: old records do not say whether the cause was
unverified history or a former metadata overflow, so this change does not guess
or automatically clear them.
The Hub contact-window refusal remains prior to this gate; its approved answer
path is unchanged and no application can waive the Hub limit.

New Classic rooms explicitly start restricted. Existing rooms with no field stay
legacy. The room setting, Needs you and General may recommend the same switch,
but neither reading nor ignoring a notice changes policy. Native CLI coverage is
reported separately: ready, restart-required, not-covered or failed. Tool filtering
and CLI hooks are policy controls, not an OS boundary against same-user processes.

Restricted rooms retain public read-only search and web fetch by default. Admins
may add exact MCP tools per room. A tool using the owner's API key or account
shows a cost and identity warning without revealing the credential. Shell,
file and subagent tools are refused only on CLI launches with verified native
coverage; room attachments use the separate broker below. Unsupported restricted
launches keep the AI tool's normal native permissions and are labelled not-covered,
never ready. Their panel says: "This AI tool/version runs with its normal
permissions; only contact approval applies." The new-room default and suggestion
card show the same warning before mode selection. This slice does not refuse
unsupported launches or add a strict mode.

Before a legacy room switches, its suggestion lists current tools that would
stop only when that inventory is known; an unavailable inventory is not a complete
list. Public reading is not synonymous with unrestricted network or shell. The
server's contact/tool ceiling and room-file broker remain enforced even without
native coverage; they do not contain the AI tool's own native actions.

## Implementation seams

A1 owns origin, policy, persistence, decisions and server adapters. A2 consumes
this contract for Permissions, Authorizations, badges and notices. A3 consumes
`ClassicChannel.restrictedMode` and `CLASSIC_RESTRICTED_TOOLS`, owns the CLI guard
module and launch hooks, and returns `ContactGuardStatus`. Unknown coverage must
never be shown as ready. All shipped paths enforce the same tool ceiling at call
time, independently of what a model's cached tool menu shows.

## Server boundaries and limitations

Standing grants bind both instance incarnations, not only their display names.
A removed, replaced or retargeted instance cannot inherit a previous grant. A target
replacement starts with a fresh policy revision, rejecting a stale open editor.
Old application content is visible only through a still-current source or target
identity. Routine daemon restarts preserve an incarnation and never resend input.

The contact table is managed by configured Fleet administrators on the target's platform, while
its configured approvers decide applications. The verified host operator is an
explicit override. A contact grant conveys only dispatch rights. A recipient's
action rights, credentials and shell are not granted or contained by this ticket.

Restricted room replies, reactions and edits use the registered adapter and room;
caller-provided adapter, chat and thread overrides do not change their destination.
Attachments are snapshotted before posting and restricted to that room's own
`workspaces/<instance>/inbox/`, including its `room-scratch/` child. Owner files,
other rooms, symlinks and hard links are refused, including Hub-answer attachments.
Attachment downloads require a file identifier actually received in that room and
copy into its own scratch. At most 20 files of 20 MiB each are brokered per reply.
This call-time fence applies even when a native CLI is reported as not covered.

Native guard readiness is separate from contact admission. A1 alone reports
not-covered until the launch guard is present. Prior transcript memory and trusted
selected MCP servers remain outside this file broker. The CLI guard is not an OS
sandbox and must report its own backend/version and network-control limitations.

### Unverified browser recovery entry

The M-3710 Needs you projection is retained: an unverified admin browser sees only
a pending-request count and Authorize this browser. Once verified, the existing
scoped request card replaces that line and names the sending Agent by display
name, with its Settings → Permissions → Clear retained origin path. Read-only and
guest sessions gain neither request details nor the clear action. This is verified
through the real poll/authorization/scoped-read flow and the mounted Needs you
card; contactActor remains verified-only. Request-scoped provenance that avoids
retained taint on signed-in admin sessions belongs to Phase 2 (M-3718), not this fix.
