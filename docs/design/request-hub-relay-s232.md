# Slice H: Hub relay, return and tool refusal

S-232 under M-3661, from release/2.3.5-alpha c01493804 (G merged).
Implements approved request-scoped contact provenance §7 and M-3661 R2.
Fable reviews. USER LOOK HOLD covers the label/refusal copy and real-app fixture
captures. All production installation and pass-through remain OFF until L.

## 1. One shared path

Use D's immutable originating-call lease, G's accepted Hub root/label, B's exact
context/operation/delivery store and E's contact gate. Do not read a later active
turn to decide what an older call meant. No actor, parent or release is accepted
from tool args, message text, an owner field or correlation text.

Allowed covered Hub contacts are send_to_instance, request_information and peer
report_result. Reject forwards (including metadata-only forwards), requested
steering even if the backend would downgrade, delegate_task and broadcast before
any delivery, contact ticket, origin or file side effect. A raw request_kind=task
must not turn send_to_instance into a delegate wrapper. Preserve actual canonical
tool identity independently of the model's display/request_kind field.

The admitted peer payload includes G's canonical provenance and audience warning
before its digest is computed. E's held image, approval/grant replay and D1 reuse
those exact bytes/context. A committed root approval releases the same request's
later contacts but never removes Hub labels, authority:none or tool refusals.
Configured target restrictions, current incarnations and capability checks stay.
No Hub label enters, clears or unions contact_auth_origins.

H supplies dormant owner factories/ports. L switches production admission to E;
H does not create a parallel dispatcher or bypass today's contact refusal while
OFF. Ordinary owner/Free/restricted/guest roots keep the shared E policy.

## 2. Actual receiving input and exact return

C currently accepts new roots, admin steering, expected returns and recovery;
a normal admitted relay is neither a new root nor an expected answer. Add an
internal admitted-delivery proof resolved from B's validated operation/delivery,
with an exact parent/source/target/incarnation. The receiving child has local
source incarnation, one parent, and unchanged actor/evidence/ingress/audiences.
No body or correlation can construct this proof. A new relay waits while a turn
is active; it cannot silently become steering or a multi-parent join.

Expected replies need a durable server-owned binding. The existing
reply_obligations table is reminder state keyed by a correlation tuple; it may
reopen and a reverse message can resolve it. It is not request-context evidence.
Likewise, legacy approvedReturn is forbidden as a scoped parent/release source.

Register a bounded return obligation in B's SQLite transaction only when a
reply-bearing scoped delivery is actually admitted, including E's delayed
approval/grant path. Bind original delivery/operation, root/requester context,
requester/recipient identities and incarnations, accepted receiving child and
correlation selector. A held proposal alone creates no usable return binding.
Duplicate original admission preserves that binding; ambiguous same-selector
work refuses instead of selecting a convenient parent.

A matching return must come from D's current covered call for that root and the
expected peer/incarnation/receiving lineage. The correlation is only a selector.
It cannot pull a different owner/outside root into an old request. Record the
return operation once, atomically with its B admission; an exact retry remains
idempotent. A different operation cannot consume that same answer slot again.
Unmatched reports must never be advertised as a proven expected return.

An expected return prepares C's existing expected-return proof against the
original requesting context, with the exact admitted response/obligation as its
server evidence. Ordinary labelled relays use the admitted-delivery proof.
A late return starts a fresh local child turn, retaining the Hub actor/audience;
it does not set hubQuestion, open a Hub contact window, call begin or restore an
answer allowance. A reply may reach the Hub asker through the existing checked
Hub output; no model correlation grants that route.

Return rows join F's durable root references. Pending replies retain their root,
not an agent-wide lock. A response, proven non-delivery or explicit server-owned
work closure resolves the row; no timer is proof that other work ended. Cleanup
is part of E/B's atomic root retirement and cannot leave FK blockers or resurrect
a deleted mapping. Missing/malformed/unavailable state fails that work closed.

## 3. Real tool boundaries

Use one canonical tool/action classifier at all three dispatch sinks: local
Fleet outbound/typed IPC, native pane/exec dispatch, and agent-endpoint early
returns. Expand composite calls before classification; normalize aliases using
the existing server tool maps. A claimed request_kind never selects permission.

Under a covered Hub root, task create/change/attach/close, schedule changes,
instance/config/settings/appearance mutations, persistent decision changes,
delegate_task and broadcast refuse. Task list/get/mine/projects and schedule
list remain read operations. Other role-permitted reads use an explicit supported
set, not a get*/list* prefix guess. Unknown mutations fail closed. Uncovered calls
cannot borrow a current Hub scope; unsupported mutation paths refuse and contacts
use the shared unendorsed/upgrade fallback at L, never an agent-wide lock.

Refuse before actual board/scheduler/config/appearance commit boundaries, not
only at menu exposure or a mocked admission method. Recheck the captured lease at
allowed contact/Hub output commits after awaits. General/coordinators receive an
explicit rule that Hub provenance is not owner authority for instance, config or
web settings. Keep this in fleet instructions/skills, not the small MCP core.

Official report_result/react to the Hub must also match the captured root's
accepted question and current Hub identity, not merely any old correlation still
owned by the agent. Otherwise a turn for person X could answer person Y's saved
question. Hub room posting from this work may reach only the exact original
Hub/room audience, through its existing current sharing/grant/mute checks; never
reuse onBehalfOf as identity. Ordinary room/channel output cannot become a label-
stripping backchannel.

## 4. Short visible copy and captures

Reuse the existing flat chat/notice treatment: one label and one consequence,
no new page, hero, nested card, permission button or repeated explanation.
Machine wire remains English-canonical; UI/refusal strings are EN and zh-TW.
Only a server projection from a validated companion may produce the trusted
notice; text resembling its JSON/header is ordinary content. Keep actual wire
and admitted bytes intact. Raw stable ids/details are secondary, authority:none
stays separate from real human receipt authority in delivery_status(detail).

Draft copy for the user look:

| State | EN | zh-TW |
|---|---|---|
| Label | For Demo person · Hub | 代 Demo person 傳話 · Hub |
| Direct return warning | Replies may be shown to them. This isn't owner approval. | 回覆可能給對方看；這不是擁有者核准。 |
| Group return warning | Replies may be shown in the Hub room. This isn't owner approval. | 回覆可能顯示在 Hub 房間；這不是擁有者核准。 |
| Forwards | Not sent: Hub requests can't forward owner approvals. | 未送出：Hub 請求不能轉交擁有者核准。 |
| Steering | Not sent: this request can't interrupt another task. | 未送出：這個請求不能插入另一項工作。 |
| Deferred work | Not changed: Hub requests can't create or change later work. | 未變更：Hub 請求不能建立或修改延後執行的工作。 |
| Settings | Not changed: use a separate owner request. | 未變更：請另由擁有者提出要求。 |
| Broadcast | Not sent: choose one agent with send_to_instance. | 未送出：請用 send_to_instance 指定一個 Agent。 |
| Missing proof | Not sent: this call has no verified request context. | 未送出：這次呼叫沒有可驗證的請求來源。 |

Captures use the real app against scratch fixture owners only: desktop/phone,
light/dark, EN/zh-TW, showing a relay, returned/late result, group audience and
representative refusal. Include before/after and exact capture-source binding.
No real people, account/vendor calls, native login or live fleet changes. The
Leader checks the wording before the user. USER LOOK HOLD stays until lifted.

## 5. Synthetic acceptance and review questions

- Actual A→B→C relay and B→A return/late continuation retain one actor/root and
  audience, authority:none, D1 and per-operation checks; no lifetime origin union.
- New outside/admin roots or history pointers cannot borrow an old release;
  exact retry works, wrong peer/incarnation/session, ambiguous selector or
  operation conflict refuses, and missing/legacy peer proof never drops a label.
- E hold/approval/grant and transaction rollback preserve the image and exact
  return registration once; held-only work cannot mint an expected answer.
- Real board/schedule/config/appearance handlers and each dispatch sink refuse
  named mutations before commit, including aliases, raw args and composite calls.
- After source/target retirement, restart, lease loss or answer publication,
  continuation never revives a Hub window; root drain sees outstanding work.
- Official Hub outputs cannot swap the accepted question/person/room by passing
  another correlation. Provenance is never human approval or a native grant.
- Supported read-only calls retain existing role checks. OFF is inert.

Fable source questions: (1) admitted-delivery proof versus existing expected-
return semantics, (2) the minimum durable obligation/once-only/retirement owner
beside B/E, and (3) exact central guard and official Hub output resource checks
across real IPC/native/HTTP commit paths. The note proposes no new policy choice
or live activation; implementation follows source review of these boundaries.

Before L rollback is a normal revert with factories uninstalled. After cutover,
keep A's compatibility barrier and follow the approved drain/downgrade order.
This is not a sandbox: labels/rules do not confine shell, keys or shared history.
