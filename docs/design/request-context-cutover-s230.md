# Request-scoped contacts: controlled cutover (S-230)

Status: proposed activation plan; implementation and evidence are not complete. Draft / USER LOOK HOLD. The user chooses A or B before merge. Nothing in this document starts or changes a running Fleet.

This is the installation slice of [the approved request-context design](request-scoped-contact-provenance.md). A–K provide dormant components; having those components in a release is not proof that their owners, transports or input bindings are installed.

## The choice for the owner

| | A — automatic after checks (recommended) | B — the owner starts it |
| --- | --- | --- |
| First start after upgrading | Check readiness, then switch on automatically if every check passes. | Keep today's behavior until the host owner turns the switch on. |
| If something is not ready | Keep today's behavior. Needs you says what blocks the change. Check again on a later start. | Explain the same blocker when the owner tries to turn it on. |
| Who gets the change | The whole Fleet, including its supported connected runtimes, together. | The same whole-Fleet change. |
| Where to change it | Settings → Fleet → Request-based contact approvals. Default on. | The same switch, initially off. |
| Turning it off | One confirmation: pause new work, finish or explicitly resolve tracked work, then return to today's contact behavior. | The same. |

The Leader recommended A on 11-26. This is a recommendation, not the user's final choice. There is one setting, not separate controls for agents, transports or database capabilities.

### What changes for people

An administrator's new request can proceed without inheriting a restriction from an earlier conversation. A restricted-room member's or guest's cross-agent request still waits for approval. Continue releases that one request and its onward steps; another request asks again. Free-room requests keep the approved Free-room behavior.

A Hub answer can ask another agent for help with a visible Hub label. The reply may go back to the Hub person or original room. That label never gives owner authority or approval. Hub work cannot change settings, create persistent work, forward owner approvals or read private Fleet details. Sharing and each tool's existing role checks still apply.

Old retained-origin rows stay as history. They stop deciding new scoped contacts only after the complete installation succeeds. An upgrade never replays an old held message, guesses its requester or clears its history.

### Proposed visible text (EN / zh-TW)

These are review copy, not claims that the surfaces already exist. Captures must come from the actual Settings, Needs-you and General paths after implementation.

| Surface | English | zh-TW |
| --- | --- | --- |
| Switch | Request-based contact approvals | 依請求核准聯絡 |
| On | On. Approvals follow each request. | 已開啟。核准只跟著這次請求。 |
| Off | Off. Using the previous contact rules. | 已關閉。使用原本的聯絡規則。 |
| Draining | Turning off. Waiting for current work to finish. | 正在關閉，等目前的工作結束。 |
| Confirm title | Turn off request-based approvals? | 關閉依請求核准聯絡？ |
| Confirm body | New work will wait while current work finishes. Then the previous contact rules will apply. | 目前的工作結束前，新工作會先等候。之後會恢復原本的聯絡規則。 |
| Confirm button | Turn off | 關閉 |
| Blocked: legacy | Request-based approvals are waiting: resolve the earlier held messages first. The previous rules still apply. | 依請求核准尚未開啟：請先處理先前擱置的訊息。目前仍使用原本的規則。 |
| Blocked: peer | Request-based approvals are waiting: update the connected runtimes first. The previous rules still apply. | 依請求核准尚未開啟：請先更新已連線的執行環境。目前仍使用原本的規則。 |
| Blocked: owner | Request-based approvals are waiting: some agents aren't ready yet. The previous rules still apply. | 依請求核准尚未開啟：部分 Agent 尚未準備好。目前仍使用原本的規則。 |
| General notice | Contact approvals now follow each request. Earlier conversations won't block an administrator's new request. You can turn this off in Settings → Fleet → Request-based contact approvals. | 聯絡核准現在只跟著這次請求。先前的對話不會再擋住管理員的新請求。可到「設定」→「機群」→「依請求核准聯絡」關閉。 |

The blocked item is one item with a concrete reason and a path to the existing held-message cards or runtime settings. It is not one item per retry. A switch-on notice is emitted once per committed activation, after the serving paths are installed, never for preparation or a failed check. It must not wake an agent as an owner request.

## Transition and ownership contract

1. **Legacy / blocked.** New admissions, prompts, tools and skills use the existing behavior. A readiness failure does not install a partial policy, bind some daemons, activate a marker or start recovering scoped work through a legacy lane. A previously active database is opened by the capable bridge before recovery, regardless of the desired switch; it cannot silently be opened by capability 0.
2. **Prepare under the exclusive Fleet owner.** Stop admitting new input across every ingress for the short transition. Re-read the legacy shadow, participating owner set, transport capabilities, generation and role revisions under that fence. No legacy unresolved ticket or unconfirmed input is adopted. A new producer or a changed generation invalidates preparation.
3. **Commit installation.** Install per-instance turns, final-write input resolvers, call leases, proof registries, drain participants, contact gate and relay, same-card API and output checks before publishing the active owner. Commit the database compatibility requirement and the cutover epoch. Resume admission only after all checks still match. A failure after durable activation keeps the fence and reports a recovery blocker; it cannot resume the old dispatcher.
4. **Active.** The installed policy determines the instruction flag. A setting alone never enables it. Stop using lifetime origin unions as permission on all ingress, relay, board and contact paths, while retaining those rows for explanation. Old-peer contact is held with an upgrade reason; metadata is never dropped to make a delivery work.
5. **Draining.** An authorized host owner confirms once. Persist the desired off state and stop independent new input. Existing exact returns and approved continuations can finish under their captured contexts; they cannot create new roots. Keep policy, labels, skills and the database barrier installed. Recheck all eight F participant families and durable returns, tickets and recovery references. Offline or unreadable state means waiting, not empty. An interruption doesn't clear references.
6. **Off after drain.** Publish the legacy serving path only after a durable, revision-bound proof says no scoped work can run or return, and the final transaction rechecks it. Retain the capable bridge and historical scoped records; do not drop downgrade guards merely to switch behavior. No database restore, ticket replay, guessed D1 or guard bypass. A supported rollback uses the capable bridge; arbitrary pre-bridge executables remain refused. Turning on again repeats readiness.

Crash after the desired-off write resumes draining. Crash after durable activation resumes capable recovery behind the admission fence. Epochs rotate on a new exclusive owner so an old process's proof cannot commit. Only the current process holding the Fleet's exclusive lock may prepare, publish, drain or revert. A timer is never evidence that work ended.

The switch changes the contact engine, not the executable version. Retained contexts, tickets and pane ledgers need not be deleted or wait for their 30-day history retention to turn the switch off. Separating **execution drain** from **historical collection** requires implementation and a test: a terminal retained record grants no running work, whereas an open return, active call or conservative recovery pointer still blocks. Older unsupported binaries remain barred even after switching off.

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

Transition controls: failed readiness leaves legacy artifacts/behavior unchanged; producer arrival during prepare invalidates it; crash before/after durable activation; no General notice on failed prepare; one notice after a committed activation; role loss during decision; stop/restart while draining; late ACK grants no authority; active/open/unknown references block off; stable empty execution proof permits off with history preserved; new input waits during drain; on re-runs readiness. Mutation controls must remove one readiness check, one currentness fence and one drain check and turn the corresponding negative red.

Real-app user look: switch on/off/draining, concrete blocked Needs-you line and General notice, EN/zh-TW, desktop/phone, light/dark. Include both A/B choices beside the plan. The gallery is evidence, not a drawn substitute for actual application paths. No live Fleet is switched for captures.

## Delivery gates

Fable reviews the design seams and implementation. Keep the PR draft with USER LOOK HOLD until prerequisite cards merge, this plan and actual visible surfaces receive the user's approval, exact-head CI is green and formal review is complete. Enabling a real installed Fleet is outside this development work and still needs the Leader's authorized rollout. No completion claim until the concrete production owners, tests and captures exist.
