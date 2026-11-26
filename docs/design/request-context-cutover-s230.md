# Request-scoped contacts: controlled cutover (S-230)

Status: selected A plan; production assembly and full-mode evidence are not complete. Draft / USER LOOK HOLD. The user chose A on 11-26: automatic after whole-Fleet readiness, with the D6 Off meaning below. Actual surfaces still need a user look before merge. Nothing in this document starts or changes a running Fleet.

This is the installation slice of [the approved request-context design](request-scoped-contact-provenance.md). A–K provide dormant components; having those components in a release is not proof that their owners, transports or input bindings are installed.

## The selected plan: A — automatic after checks

The user chose A on 11-26. The upgrade checks the whole Fleet at its first start and enables request-based approvals only when every required owner and runtime is ready. A never-activated Fleet that fails readiness keeps its existing behavior. Needs you names the blocker and offers Check again; it also rechecks when a blocker resolves or at a later start. Never half-enable.

The host owner gets one switch in **Settings → Access & security → Request-based contact approvals**, default on. This is the existing Settings page, not a new Fleet tab. Switching on again rechecks readiness. General receives one short notice after a committed activation.

**Turning it on once means older versions cannot open this Fleet's data, even after Off.** Automatic A makes this minimum-version change after readiness passes. Off changes contact behavior; it does not downgrade the executable or restore the lifetime-origin engine.

**Off:** pause new outside requests, finish or explicitly resolve current work, then stay on the capable bridge. Your own proven fresh requests go through; requests that came from outside wait for your decision. No rollback shadow, union copying, inferred resolution or origin reset. The owner confirms Off once; unresolved work is listed with its explicit resolution actions.

If data activation committed but installation failed, keep the admission fence and show why. Retry installation on each start. The owner's Off remains available independently of the failed installer; with no scoped work it can complete immediately. Otherwise the draining view names what needs resolution. A repair never replays an operation or removes the downgrade barrier.

### What changes for people

An administrator's new request can proceed without inheriting a restriction from an earlier conversation. A restricted-room member's or guest's cross-agent request still waits for approval. Continue releases that one request and its onward steps; another request asks again. Free-room requests keep the approved Free-room behavior.

A Hub answer can ask another agent for help with a visible Hub label. The reply may go back to the Hub person or original room. That label never gives owner authority or approval. Hub work cannot change settings, create persistent work, forward owner approvals or read private Fleet details. Sharing and each tool's existing role checks still apply.

Old retained-origin rows stay as history. They stop deciding new scoped contacts only after the complete installation succeeds. There is no rollback shadow and no copying unions onto receivers, including while Off after activation. An upgrade never replays an old held message, guesses its requester or clears its history.

### Proposed visible text (EN / zh-TW)

These are review copy, not claims that the surfaces already exist. Render the last sentence on blocked lines only for a never-activated Fleet; after activation omit it (do not show the conditional wording itself). Captures must come from the actual Settings, Needs-you and General paths after implementation.

| Surface | English | zh-TW |
| --- | --- | --- |
| Switch | Request-based contact approvals | 依請求核准聯絡 |
| On | On. Approvals follow each request. | 已開啟。核准只跟著這次請求。 |
| Off | Off. Your own messages go through as usual; requests that came from outside wait for your decision. | 已關閉。你自己的訊息照常；從外部來的請求會等你決定。 |
| Draining | Turning off. Waiting for current work to finish. | 正在關閉，等目前的工作結束。 |
| Confirm title | Turn off request-based approvals? | 關閉依請求核准聯絡？ |
| Confirm body | New outside requests will wait while current work finishes. Then your own messages go through as usual; outside requests wait for your decision. | 新的外部請求會先等候，直到目前的工作結束。之後，你自己的訊息照常；從外部來的請求會等你決定。 |
| Confirm button | Turn off | 關閉 |
| Blocked: legacy | Request-based approvals are waiting: resolve the earlier held messages first. If this Fleet has never activated, the previous rules still apply. | 依請求核准尚未開啟：請先處理先前擱置的訊息。若這個機群尚未開啟過，目前仍使用原本的規則。 |
| Blocked: peer | Request-based approvals are waiting. Update or reconnect these runtimes: {names}. | 依請求核准尚未開啟。請先更新或重新連線這些執行環境：{names}。 |
| Blocked: owner | Request-based approvals are waiting. These agents aren't ready yet: {names}. | 依請求核准尚未開啟。這些 Agent 尚未準備好：{names}。 |
| General notice | Contact approvals now follow each request. Earlier conversations won't block an administrator's new request. The switch is in Settings → Access & security → Request-based contact approvals. Older versions cannot open this Fleet's data, even after you turn it off. | 聯絡核准現在只跟著這次請求。先前的對話不會再擋住管理員的新請求。開關在「設定」→「存取與安全」→「依請求核准聯絡」。即使關閉，舊版也無法再開啟這個機群的資料。 |

The blocked item is one item with a concrete reason, the affected agent/runtime display names, a path to the existing held-message cards or runtime settings, and **Check again**. Recheck when its blocking ticket/owner/runtime changes as well as on later starts; deduplicate rechecks by the owner/capability epoch. It is not one item per retry. A switch-on notice is emitted once per committed activation, after the serving paths are installed, never for preparation or a failed check. It must not wake an agent as an owner request.

## Transition and ownership contract

1. **Legacy / blocked.** New admissions, prompts, tools and skills use the existing behavior. A readiness failure does not install a partial policy, bind some daemons, activate a marker or start recovering scoped work through a legacy lane. A previously active database is opened by the capable bridge before recovery, regardless of the desired switch; it cannot silently be opened by capability 0.
2. **Prepare under the exclusive Fleet owner.** Stop admitting new input across every ingress for the short transition. Re-read the legacy shadow, participating owner set, transport capabilities, generation and role revisions under that fence. No legacy unresolved ticket or unconfirmed input is adopted. A new producer or a changed generation invalidates preparation.
3. **Commit installation.** Stage per-instance turns, final-write input resolvers, call leases, proof registries, drain participants, contact gate and relay, same-card API and output checks behind the admission fence. A **single outbox database transaction** commits the compatibility floor, cutover epoch and active owner generation together. Its activation record is read in `ensureDeliveryOutbox`, before `recoverForBoot`, any pump, pane monitor or producer. Record absent means legacy; record present always means capable open/recovery behind the fence, whatever the desired setting says. After commit, one process-owned installation reference is the single publication point; every ingress captures it per admission, never once at boot. A single `requestContextPolicyInstalled` predicate derived from that reference controls the origin-union bypasses, prompts, skills and instruction flags. The config value is read only by Settings and the installer, enforced by a source-scan test. Resume admission only after every staged owner and transport snapshot still matches.
4. **Active.** The installed policy determines the instruction flag. A setting alone never enables it. Stop using lifetime origin unions as permission on all ingress, relay, board and contact paths, while retaining those rows for explanation. Old-peer contact is held with an upgrade reason; metadata is never dropped to make a delivery work.
5. **Draining.** An authorized host owner confirms once. Persist the desired off state and stop independent new input. Existing exact returns and approved continuations can finish under their captured contexts; they cannot create new roots. Keep policy, labels, skills and the database barrier installed. Recheck all eight F participant families and durable returns, tickets and recovery references. Offline or unreadable state means waiting, not empty. An interruption doesn't clear references.
6. **Off after drain.** Publish the capable owner-only serving mode only after a durable, revision-bound proof says no scoped work can run or return, and the final transaction rechecks it. Retain the capable bridge, the outside-request gate and historical scoped records; do not drop downgrade guards merely to switch behavior. Only proven fresh owner inputs bypass the per-request contact checks. Outside work stays held until explicitly resolved; no old-origin permission engine is restored. No database restore, ticket replay, guessed D1 or guard bypass. “Rollback” here means the capable owner-only Off mode, not the old contact rules. A supported executable rollback uses the capable bridge; arbitrary pre-bridge executables remain refused. Turning on again repeats readiness.

Crash after the desired-off write resumes draining. Crash after durable activation resumes capable recovery behind the admission fence. Retry installation on every start, and expose a single Needs-you recovery blocker with Retry and the owner-only Off control. **Off remains available when installation failed**: an independent read-only drain assessor uses the owned durable records and launch/call registries; it does not require the failed policy installation. A proved absence of scoped execution permits Off immediately. Missing/unreadable state blocks it with a named resolution action rather than guessing empty. Epochs rotate on a new exclusive owner so an old process's proof cannot commit. Only the current process holding the Fleet's exclusive lock may prepare, publish, drain or revert. A timer is never evidence that work ended.

The local Fleet lock does not stop a remote producer. During preparation, ingress retains arrivals behind the fence; an arrival changes the producer revision and invalidates that preparation. Re-read remote connection generations and negotiated capabilities inside the final commit checks. Disconnect/reconnect to an older peer between prepare and commit prevents activation; it cannot become a post-commit downgrade hold after a falsely successful cutover.

The switch changes the contact engine, not the executable version. Retained contexts, tickets and pane ledgers need not be deleted or wait for their 30-day history retention to turn the switch off. Separating **execution drain** from **historical collection** requires implementation and a test: a terminal retained record grants no running work, whereas an open return, active call or conservative recovery pointer still blocks. Older unsupported binaries remain barred even after switching off.

### Resolving drain blockers

The Draining Needs-you item lists each blocking operation and the action the host owner can take. Each action requires current verified owner authority and CAS against the exact item/epoch. None is inferred from age.

- An open expected return: **Stop waiting** explicitly abandons that obligation, records a server-owned terminal closure and tells the waiting agent the return was refused. A late reply cannot reopen or borrow its scope. It does not pretend the original delivery never happened.
- A pending ticket: **Decline**; an approved but not yet delivered operation: **Withdraw**, only before its delivery crossed the consumption boundary. Notify the requester. An uncertain operation needs inspection/reconciliation; it cannot be relabelled undelivered by a click.
- A deferred/task-board/scheduled wake carrying a parent: cancel that exact registered wake and tell its owner. A multi-parent or unowned wake is unavailable, not empty. A supported owner wake without a scoped parent is outside this blocker set.
- A recovery pointer: **Stop this work** voids the exact pointer only after its old launch/run is proved retired and no associated call/return can still run. No fresh owner root is inferred from this action. History remains; it is not proof of semantic isolation.
- A live call, grant, pending final-write stamp or running pane: wait for its owned result or use the existing explicit stop/fresh-launch path. An unconfirmed side effect stays an inspectable blocker; no forced success or repeated operation.

The complete Off predicate covers all eight F families **and** their durable joins: scoped queued/deferred/uncertain/reconciliation outbox rows, open tickets and returns, registered parent-bearing board/schedule/system wakes, active daemon/exec turns and calls, native grants, pane proof leases awaiting input/write, pane ledgers with unfinished calls, and recovery pointers. Readable terminal ledger/history rows alone do not block Off; malformed/unavailable registries do. A test leaves each listed open state as the sole blocker and proves Off refuses it.

### Off and history — Leader decision 11-26 (D6)

The Leader selected **no rollback shadow and no union copying in any form**. During the transition, stop new scoped roots and drain. After that, the capable bridge allows proven fresh owner inputs normally; outside requests wait for an explicit decision. This is not a return to the previous contact engine.

Retained Hub, guest or peer scope from the Active period is explicitly resolved, never inferred from a later administrator message, reset, copied or converted into owner authority. A present scoped request keeps its label, audience and restrictions even if approved. Off does not automatically start new outside work: show the held request and use its exact decision path. An unrelated history pointer cannot borrow that decision. Keep the compatibility floor and capable recovery. Readiness-block copy may say “previous rules” only when the activation record has never existed.

Required regression: on → changed/cleared contact history and scoped decisions → off; no stale origin is reactivated, no union is reconstructed, no scoped approval becomes a blanket grant, and retained outside work is held until its explicit resolution. Proven fresh owner input must not be confused with steering or resuming that outside work.

## Concrete source seams to assemble

| Owner / seam | Required installation or change | Failure protected against |
| --- | --- | --- |
| Fleet startup, before outbox recovery / pumps | Capable database open on an activated home; exclusive-owner admission fence, complete shadow and exact owner/capability snapshot. | Half-enable or old-code dispatch after a crash. |
| Native / Classic / web / button input | Server-admitted receipt and trusted guest/room classification; root and audience evidence captured before input. Signed-in identity remains separate from authority. | Owner substitution, guest laundering, raw-header identity. |
| Daemon final write | Prepare against final formatted wire digest and exact runtime owner inside C's write lock. Distinct turns per agent. | Raw-text hash mismatch or later-turn adoption. |
| Exec claim | Same admitted-input rules, distinct per-agent turn state, immutable grant closure. | Cross-agent active-state collision or status-read-dependent recovery. |
| Hub 1:1 and room dispatch | Invoke G before files/input intent; verified current destination, stable root and defer handling. | Consumed-journal lookup, owner fallback or a second root on redispatch. |
| B delivery consumption / H relay | Validate admitted operation and deterministic receiving child against exact attempt; registered returns only. | Correlation-based release, same-root reply laundering. |
| Local / remote panes and native MCP | Two-sided strict protocol, final-write proof install, synchronous first-hop stamp, exact launch/call ownership. Bind all F registries before any producer. | Late call borrowing an administrator's next turn. |
| Interrupted persistent launch | Keep D's not-covered behavior; one-operation approval using the reviewed S-249/S-250 reason, no standing grant or agent-wide lock. | Accepting the explicitly rejected first-hop residual. |
| Human / contact / board lifetime reads | Preserve existing code while OFF; replace permission decisions only under the installed owner. Split or refuse unsupported multi-parent wakes. | An unrelated administrator clearing outside work, or a history union locking the Fleet. |
| Same-card host and native post | Install I's target-manager reads and current CAS writer; native server-fixed destination and callback actor. Keep legacy and scoped decisions fenced. | Hidden-state leak or stale / wrong-bot approval. |
| Instructions / skills | Actual installed flag only; activation-conditioned publication of return-audience and no-owner-authority rules once per role. MCP core unchanged. | Shipping unenforced rules while OFF or inflating every prompt. |
| Settings / Needs you / General | Host-owner authority for writes; readiness status read with existing admission; one confirmation; same controls on public links. | Browser tier or a model directly activating policy. |

## Readiness and acceptance evidence

All prerequisites are conjunctive: S-249/S-250 and H/J/K reviewed user looks; complete stable F shadow with no unresolved legacy work; every configured participating daemon/exec/pane owner supported and generation-bound; both ends of remote protocol supported; actual final-write and call ports installed; all drain families registered; exclusive Fleet owner still current. A missing owner or disconnected old peer is not an empty participant. Preflight itself must not send vendor traffic or start live agents.

Full-mode fixtures must exercise the approved mode matrix through real admitted ingress → final write → tool entry → E decision/B admission → receiving child, including file/forward hashes and exact native/web identity. Positives: administrator unverified restricted root, Free-room member, restricted Continue/D1 onward, Hub labelled relay and exact/late return. Negatives: guest in a Free room, administrator steer into outside work, unrelated history reply, Hub private reads and side effects, expired identity, old peer, stale owner, changed payload, interrupted launch, duplicate decisions, recovery without a proven parent and unsupported multi-parent work.

Transition controls: failed readiness leaves legacy artifacts/behavior unchanged; producer arrival during prepare invalidates it; crash before/after durable activation; no General notice on failed prepare; one notice after a committed activation; role loss during decision; stop/restart while draining; late ACK grants no authority; active/open/unknown references block off; stable empty execution proof permits capable owner-only Off with history preserved; new input waits during drain; on re-runs readiness. Mutation controls must remove one readiness check, one currentness fence and one drain check and turn the corresponding negative red.

Real-app user look: switch on/off/draining, concrete blocked Needs-you line and General notice, EN/zh-TW, desktop/phone, light/dark. Include the selected A plan and its minimum-version/Off explanation beside the captures. The gallery is evidence, not a drawn substitute for actual application paths. No live Fleet is switched for captures.

## Delivery gates

Fable reviews the design seams and implementation. Keep the PR draft with USER LOOK HOLD until prerequisite cards merge, the actual visible surfaces receive the user's approval, exact-head CI is green and formal review is complete. Enabling a real installed Fleet is outside this development work and still needs the Leader's authorized rollout. No completion claim until the concrete production owners, tests and captures exist.

## Fable design review resolution (D1–D8)

| Finding | Resolution / acceptance owner |
| --- | --- |
| D1: permanent version floor | Selected A plan and General notice explicitly say Off does not restore old-version access. User selected A on 11-26. |
| D2: atomic record / publication | Transition 3: one outbox transaction for floor, epoch and active owner generation, read before recovery; one published installation reference per admission. |
| D3: failed-install exit | Independent owner Off and read-only drain assessment; retry each start, named blocker, immediate Off when no execution exists. |
| D4: indefinite drain | Named owner actions for returns, tickets, wakes and recovery pointers; uncertain effects require reconciliation, not forced closure. |
| D5: complete drain | Explicit eight-family and durable execution list, each with an isolated negative control; history retention is separate. |
| D6: history freshness | Leader chose no shadow/no union copying. Capable owner-only Off keeps outside scope awaiting explicit resolution; never restore stale legacy rows. |
| D7: single predicate | Installed publication predicate only, including staged-vs-published daemon prompt control; source scan required when full assembly lands. |
| D8: remote arrivals | Producer revision invalidates preparation; remote generation and strict negotiated capability rechecked at commit. |
| UX: recheck / names | Check again plus blocker-resolution rechecks; affected runtime/agent display names are included. |
