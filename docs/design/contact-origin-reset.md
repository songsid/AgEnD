# Administrator contact-origin reset

Status: first-slice design approved 2026-11-19 at `84906ffea`. Dev-only.
This extends the contact-origin behavior in classic-contact-authorizations.md;
it does not add a sandbox, credentials broker or model-decided permission.

## First slice: an explicit administrator override

Every agent's Permissions tab shows its retained origin: none, one known person,
mixed people, or unknown. Show known people, the bounded agent-hop chain and
receipt count, including inherited origins on ordinary workers. Existing scoped
read permissions remain; no new public or peer read endpoint is added.

A verified target Fleet administrator or verified host operator may select
**Clear retained origin**. Use the same management identity checks as editing
contact permissions. A room admin who may only change the room mode, a configured
approver outside that management scope, a guest, a peer or the agent itself cannot
invoke this action. It is an authenticated web-only action, not an MCP tool.
Existing same-host-user trust assumptions remain; this is not an OS isolation
boundary against a process that possesses the administrator's credentials.

Clearing is an administrator's explicit acceptance of the current retained
conversation as their own work. Replace the accumulated union with a known
origin naming that verified administrator, with no claimed human-message receipt.
Do not merely delete the row: a restricted room with no origin fails closed as
unknown and would otherwise remain stuck. This override does not erase CLI
history or prove that its contents have disappeared. New inbound work merges
its real origin again. No idle, restart, later administrator message or compaction
ever invokes this action automatically.

Confirmation copy (M-3830: a restricted ClassicBot room and a fleet agent differ in one sentence, because only a
restricted room records the people who talk in it):
- Restricted ClassicBot room, EN: "Clear this agent's retained origin? You accept its current conversation as your own work. Earlier text is not erased. New non-admin requests will require approval again. Other agents, existing tickets and grants are unchanged."
- Restricted ClassicBot room, zh-TW: 「清除此 Agent 保留的來源？這表示你接受目前對話作為自己的工作，先前文字不會刪除。新的非管理員請求仍會再次需要核准。其他 Agent、既有申請與授權都不變。」
- Fleet agent, EN: "Clear this agent's retained origin? You accept its current conversation as your own work. Earlier text is not erased. Work it later receives from a restricted room or an agent that needs approval will need approval again. Other agents, existing tickets and grants are unchanged."
- Fleet agent, zh-TW: 「清除此 Agent 保留的來源？這表示你接受目前對話作為自己的工作，先前文字不會刪除。之後從受限房間或需要核准的 Agent 接手的工作，仍會再次需要核准。其他 Agent、既有申請與授權都不變。」

The request carries the observed policy revision and a separate monotonic origin
revision. The server rechecks the verified actor, target incarnation and both
revisions immediately before the transaction. New input/relay origin after the
page read returns conflict; no newer origin may be silently cleared. Origin
revision increments on every accepted origin write and manual clear, including
an otherwise identical origin, so an old confirmation cannot pass an ABA cycle.
A repeated stale request returns conflict, without another clear or audit row.

In one transaction: replace the union, increment origin revision, and append an
`origin-clear` audit entry with actor, time, agent incarnation and before/after
origin images. Do not rewrite pending tickets, their frozen origin, grants,
approved return bindings or other agents' inherited histories. A pending ticket
still requires its own decision. Clearing cannot waive the M-3160 Hub window or
change the native tool guard. Publish the normal contact-auth refresh after
commit. No CLI launch, restart or automatic delivery is part of the clear action.

API sketch: POST `/ui/api/instances/:name/contact-permissions/origin-clear` with
`{revision, originRevision, generation}`; response is the updated Permissions DTO. No client
identity, arbitrary origin or authority text is accepted. GET Permissions adds
`originState` (kind, people, chain, receiptCount, revision, generation, canClear, lastCleared). The tab always shows the last clear
actor and time from the audit for this incarnation, even after later input. No stored
receipt IDs need to be exposed. Existing servers without this field offer no
clear control. History uses the existing list and localized action labels.

## Later: work-item scoping

A task-board status, an arbitrary correlation string, an idle period or an
answer is not sufficient evidence that derived text stopped influencing the
conversation. Do not clear a per-instance union at those boundaries. A later
work-item design needs server-owned parent/child work IDs, persistent origin
inheritance for relays, schedules and summaries, and a verifiable closed work
scope. The ordinary CLI transcript still mixes work, so closing an item alone
cannot prove that its origin is gone. Keep this design-only until that influence
boundary and its recovery behavior are demonstrated and reviewed.

## Later: a provably fresh session

A daemon boot ID, process restart or retained resume does not establish a fresh
conversation. Compaction explicitly preserves derived text in a summary.
Automatic clearing may only follow an AgEnD-initiated fresh session or an
observed CLI clear with backend-specific evidence: acknowledged command, new
session identity/record boundary and no prior transcript or injected summary.
The proof must refer to the current launch and input epoch; a concurrent inbound
message invalidates it. Commit the new session binding and origin reset together,
then allow input. Unsupported or uncertain backends keep the origin unchanged.
No such automatic reset is included in the first slice.

## Verification and rollback

Use synthetic identities and owned SQLite/API/browser fixtures. Pin management
identity, stale origin/policy/incarnation refusal, atomic audit/reset rollback,
replayed confirmation refusal, inherited-worker and unknown visibility, preserved
tickets/grants/other agents, new-input re-restriction and Hub refusal after clear.
Capture the real web Permissions tab headlessly inside WSL using fake data.

The origin-revision table and optional DTO/history fields are additive. Revert
and restart to remove the control; the previous build reads the administrator's
known origin normally. Rollback does not restore an origin deliberately cleared
by an administrator. Keep the audit as the record of that decision.
