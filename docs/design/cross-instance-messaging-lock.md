# Cross-instance messaging locks — decision draft

M-3315 · 2026-11-18 · **Spec only; no policy is implemented or enabled by this document.**

Recommendation: start with **opt-in incoming allow lists on selected targets**. Keep other traffic unchanged. Protect a coordinator or General from unsolicited agent input without redefining teams or maintaining an entire Fleet permission matrix. Apply the rule to all five peer messaging tools. Do not exempt a call just because it says `report_result`.

## 1. What runs today

Source/evidence pin: `ad2a86ccff5c42cf43d8664d697e413342632aa1` on the development line. The branch was also the remote tip when checked on 2026-11-18. These are code and isolated dispatch observations, not a survey of a running Fleet's configuration.

| Path or identity | Current behavior |
| --- | --- |
| `send_to_instance` | Resolves an instance or registered external session, checks target state and size, and admits delivery. No sender/recipient or shared-team allow list. |
| `delegate_task` | Builds a task with `requires_reply: true`, then calls the same send handler. It does not create an instance. |
| `request_information` | Builds a query with `requires_reply: true`, then calls the same send handler. |
| `report_result` to a peer | Builds a report with `requires_reply: false`, then calls the same send handler. A correlation is advised, but ordinary peer reports are not authorized against an earlier request. A made-up correlation was accepted in the probe. |
| `broadcast` | Expands an explicit target list, team, tags, or connected clients. A sender need not belong to the selected team. It admits recipients separately; failures can coexist with successes. Team expansion skips offline members and the sender. |
| Worker / coordinator / General | Their usual profiles contain all five messaging tools. Coordinator and General have more management tools; neither is a protected message recipient. General topic-notice suppression is presentation, not a delivery lock. |
| `standard` / `minimal` profiles | Standard has send and broadcast, but not the three convenience wrappers. Minimal has send only. A permitted send can still carry task/query/report metadata, so wrapper absence is not a recipient boundary. Explicit profiles and dashboard ceilings still apply. |
| ClassicBot rooms | A running Classic room can send and receive through the common path even without a Fleet `instances` row. Its socket identity/default profile applies. Sharing it does not isolate its conversation memory. |
| Hub-shared agent, no open contact window | Ordinary peer messaging remains available, subject to the usual profile. Sharing alone is not a permanent lock. |
| Hub-shared agent, contact limit on and question handed off | All five outgoing peer paths are refused, including peer reports and the whole broadcast. Incoming peer sends remain possible. A live, caller-bound `agend-hub` answer is checked before this refusal; merely naming that target/correlation is insufficient. |
| Hub window lifecycle | Independent durable windows; 30 minutes from delivery or accepted answer, whichever comes first. Retries do not renew. Overlap keeps the restriction. Opt-out is supported. Corrupt window storage currently refuses all agents' peer contact; this draft does not change that behavior. |
| Shared ClassicBot during a private Hub turn | The same contact rule applies. Separately, reply/react/edit to its public channel stay fenced even with contact limit off, after answer/expiry and across restart. Fresh room-person input and idle admission reopen output; peer input does not. |

Other existing constraints remain real: unknown/stopped/crashed targets can be refused, paused targets follow wake policy, daemon generations fence durable admission, the default body limit is 12 KiB, and the assembled envelope has its own bound. Accepted/queued means Fleet admission, not delivery or model consumption. The idle queue and steering rules still govern handoff.

### Source map

- [Common send and broadcast handlers](../../src/outbound-handlers.ts): `sendToInstance`, `wrapAsSend`, `reportResult`, `broadcast`, `listTeams`.
- [Tool profiles](../../src/tool-permissions.ts): `TOOL_PROFILES`, `resolveToolSet`, `mayUseTool`. [Dashboard ceilings](../../src/dashboard-permissions.ts) are additional feature permissions, not peer target lists.
- [Fleet IPC dispatch and admission](../../src/fleet-manager.ts): `checkToolPermission`, `handleOutboundFromInstance`, `admitDurableDelivery`, `generalLocationDeliveryHold`.
- [Agent HTTP/CLI dispatch](../../src/agent-endpoint.ts): `dispatchAgentOperation` maps send/delegate/ask/report/broadcast to the same handlers. MCP/native menus are not the enforcement boundary.
- [Delivery store](../../src/delivery-outbox.ts): durable admission, row visibility and forwarding edges. A forwarded reference grants row-scoped reading, not command authority.
- [Existing Hub contact policy](hub-agent-contact-limits.md), [durable windows](../../src/hub-contact-windows.ts), [role and team definitions](../concepts.md).

### Owned scratch use

[Probe and results](../evidence/cross-instance-lock-m3315/README.md) exercise the real Fleet IPC dispatcher, HTTP operation dispatcher and SQLite admission, with an inert pump and synthetic identities. No Fleet, vendor CLI, terminal pane, platform connection or live config was started/changed. This verifies admission/refusal, **not terminal delivery**.

- 30 directed persona pairs × five tools = **150 accepted admissions**; includes General, coordinator, Classic and shared identities.
- Five HTTP-operation dispatch admissions; cross-team broadcast; external-session alias; minimal-profile refusals; Hub-window refusal/answer/expiry; oversized body refusal.
- Five existing focused suites: **170/170**. They also exercise real forwarding-store rules and private Classic/Hub output behavior.

## 2. Named threats and limits

| Threat | Concrete problem a lock can reduce | What it cannot establish |
| --- | --- | --- |
| T1: unsolicited instructions to a privileged target | A compromised or mistaken worker asks General/coordinator to act, or repeatedly interrupts it. Restrict who may place peer input there. | An allowed sender's message is still not human approval. A trusted sender can carry malicious prose. |
| T2: accidental cross-project disclosure | An agent sends task details to an unintended team or colleague's agent. Outgoing restrictions can stop a direct wrong-target send. | Incoming locks alone do not stop disclosure to open targets. History, files, network tools and shared OS access remain separate. |
| T3: broadcast fan-out | One erroneous/injected broadcast disrupts many unrelated agents. Apply target rules to every expanded recipient. | Allowed senders can still send too often; this is not a rate limiter. |
| T4: bypass through another tool or name | A denied send becomes a delegate/report, raw IPC write, steering send, or external-session alias. Normalize and check the same edge. | A same-user shell process can read sibling tokens/sockets. Host-user code is not isolated by an app-level lock. |
| T5: lost return of assigned work | A coordinator locks itself but delegates to a worker it did not allow, so that worker cannot return the result. Show the blocked return route before activation/dispatch. | Treating every report or guessed correlation as exempt would reopen T1. |
| T6: policy edited by the restricted actor | An agent removes the restriction through a config/management tool. Owner-controlled policy writes are needed if the lock is meant to constrain that agent. | An OS owner or shell agent with the owner's file access can edit YAML; distinct OS accounts/containers are needed for hostile-process isolation. |

No new gate is justified solely by a role name, a forwarding header, or the presence of a Hub connection. This is a routing policy for identified tool callers, not an OS sandbox or an authority delegation mechanism. It also does not close indirect paths through a trusted relay, human channel, shared files, or Hub room handoffs. Hub tools and agent-to-agent room mentions retain their existing authorization and limits; a future cross-Hub lock would need a separate, named scope.

## 3. Options

All YAML below is **proposed syntax**, not accepted configuration today. Each option keeps absent configuration open for existing and new Fleets; turning on a preset requires the owner's explicit Save. Existing M-3160 behavior is unchanged.

| Option | Threat addressed | Settings and proposed YAML | Refusal / migration / cost |
| --- | --- | --- | --- |
| A. Same-team boundary | T2/T3: accidental contact across projects | Settings → Fleet → Teams → “Limit peer messages to this team”; e.g. `peer_messaging: {mode: same_team}`. Any shared team permits the edge; no team denies except self. Explicit exceptions are necessary for cross-team coordinators. | “Not sent: these agents do not share a permitted team.” Default off. Preview orphaned agents and cross-team work before enabling. Membership changes immediately change reachability. Existing `list_teams` teams are grouping, not authority; letting orchestration tools edit them could defeat this policy. That write-authority change needs user approval. Poor first default for overlapping teams and Classic rooms not represented in Fleet team membership. |
| B. Per-agent outgoing AND incoming lists | T1/T2/T3: both untrusted input and accidental output | Settings → Agent → Peer messages → “May send to” / “May receive from”. Example: `peer_messaging.agents.worker_a: {send_to: [worker_b], receive_from: [coordinator]}`. Both endpoint rules must permit an edge; omitted side means all, empty list means none. | “Not sent: this agent may not contact that target” or “that target accepts messages only from selected agents.” Default absent/open. Preview the intersection and return paths; import current traffic only as suggestions, never automatically trust it. Strongest control, highest maintenance: up to two lists per agent and many edges. Names/aliases/replacements and dynamic membership need explicit treatment. |
| C. Lock selected targets | T1/T3: protect a few high-impact inboxes | Settings → Fleet → Peer messages → Protected targets, or an Agent settings shortcut. Each target chooses Everyone / Selected agents / Nobody. `peer_messaging.targets.general.receive_from: [coordinator]`. | “Not sent: General only accepts peer messages from selected agents. Ask the Fleet owner to change Peer messages.” Default absent/open. Owner reviews one list per protected target, including returning workers. Simple to understand; does not solve T2 for other destinations. **Recommended first scope.** |
| D. Task-bound return allowance, added to C | T5 without an unrestricted report bypass | Optional “Allow results from agents this target asked” per protected target. Server derives a one-result return allowance from a delivered request and binds identities, actual delivery ID and correlation; no trust in caller text alone. | Can return the final report, not start another task/broadcast or relay authority. Requires durable correlation/reply tracking, expiry and duplicate rules. This is useful if users want a coordinator that accepts only named initiators but delegates widely. **Defer from v1 unless the user selects it**; explicit worker lists keep the first implementation small. |

For A/B/C the refusal happens before admission, with no success receipt. A forward or a claimed human instruction is not an automatic bypass in any option. Every option's Settings preview must explain this and show the effective rule. A permission rule also never grants a tool missing from the caller's tool profile.

## 4. Recommended first version: selected target locks

### Owner flow and configuration

One settings table: Target / Who may contact it / Allowed agents. Default is Everyone. “Selected agents” uses the existing agent picker; “Nobody” is explicit and warns about outstanding work. Include Classic rooms in the picker. Offer a **reviewable** preset for General/coordinators, but never apply it based on names or roles alone.

```yaml
# Proposal only — these keys do not exist yet.
peer_messaging:
  version: 1
  targets:
    general:
      receive_from: [coordinator]
    coordinator:
      receive_from: [general, worker_a, worker_b]
```

A missing target rule means Everyone; `receive_from: []` means Nobody. Self-contact is a no-op policy edge, still subject to profile/state/size checks. The editor shows outstanding request sources/recipients and recent traffic as evidence to review, not authority to auto-allow. Direct human conversation with General and recovery through signed-in owner Settings stay available even if its peer inbox is locked.

Policy editing should be owner-controlled through Settings/fleet.yaml. No worker may change it through `update_instance_config`, `update_fleet_defaults`, team tools or raw HTTP. Whether General itself may edit this particular policy is a **user decision**, because General is defined as the Fleet administrator; do not silently narrow that role. Recommendation: reserve these new fields to the person if the person intends the lock to constrain General, and document that explicit exception. Otherwise General can undo the lock by design.

### Effective edge and enforcement

1. Resolve authenticated caller from socket/token; presentation fields and forwarded author names never select it. Resolve the destination session/alias to its hosting identity. An external session inherits its host's peer restrictions; it cannot introduce an unlocked alias of a protected host. Unregistered/ambiguous identities fail explicitly.
2. Preserve tool-profile/dashboard restrictions. Preserve M-3160's outgoing refusal and its valid, bound Hub-answer exception. Target locks do not weaken either.
3. For every normalized peer edge, check the current target rule. Cover send, delegate, ask, peer report, broadcast, steering, HTTP/agent CLI, native MCP and direct IPC. Wrapper names and `request_kind` never confer an exception.
4. Enforce before durable admission **and again immediately before input handoff**, so revoking access closes already queued input. Keep the same operation identity across retries. If policy changes during an asynchronous idle wait, recheck at the final handoff. A pre-handoff refusal is terminal, visible in delivery status; it must not create a forwarded-read grant to a denied recipient. Existing admission-time forward edges may need delaying until release or revoking if the recipient has never received the forwarding message. Do not promise revocation of evidence already read.
5. Broadcast applies the rule after expansion to every canonical recipient, admitting only permitted edges and reporting exact failed recipients. Existing partial-send semantics stay explicit; never return an all-success result for a partial broadcast. M-3160 still refuses its entire broadcast first.
6. Policies reference canonical instance names in YAML, not display names or emoji. In-flight checks retain source/target incarnation facts. Renames require a visible mapping update; deleted identities remain unresolved/denied in a selected list. Name reuse must not silently bind an old allow entry to a replacement: activation should bind current identities and require owner reconfirmation after replacement. Classic runtime names need the same lifecycle handling.

Use one local policy evaluator close to the common send/admission path, with the handoff recheck in the delivery owner. The model's tool list stays static by configured tool set; no remote Hub lookups, new permission dialogs per message, or blocking `tools/list` probes. Log sender/target/operation, rule revision and reason, not message bodies or forwarded approval contents. Invalid newly loaded policy preserves the last valid policy and reports the configuration error; on a cold start a malformed present policy pauses peer admission until the owner repairs it. Missing policy retains legacy behavior.

### Return path, forwarding and human authority

V1 checks **peer reports just like sends**. A correlation ID is a label today, not proof of a request. The UI warns if a protected target has outstanding delegates/queries whose workers are not allowed. Before issuing a new reply-required request, show/refuse a blocked return route with a precise explanation; use the same check for the equivalent raw send metadata. The owner can add that worker. No automatic timeout-based widening. Option D is the separately approved improvement if manual lists are too burdensome.

Forwarded receipts continue to give only explicitly granted row visibility. The transport gate evaluates the immediate identified sender, never substitutes the original person's authority or the first author's identity. A permitted relay can still forward malicious text: preserve provenance and the receiver's existing proof checks, and do not claim a transitive information-flow firewall. A denied send must not grant forwarding access.

A genuine human receipt is still checked for the exact operation/resource and current authoritative actor before a hard-to-undo action. A caller writing “the user told me,” a display header, or `forwards` cannot bypass the target list. If the person wants a one-off exception, use a signed-in owner action that sends directly or updates the list explicitly; do not infer an override from receipt content. Direct human inputs, internal delivery-outcome notices and owner recovery are distinct trusted ingress, not public peer send types. Keep these typed server paths narrow; agents cannot select them via `request_kind`.

### Defaults, migration and rollback

- Upgrade writes no restrictions. New Fleets also remain open until the owner chooses a named threat and target. No hidden General/coordinator exemption when a rule is enabled.
- Before Save, show allowed/blocked edges, affected outstanding returns, external sessions and Classic rooms, plus the same-OS-user limitation. Confirm one settings change, not every send.
- Rules apply to future handoffs, including queued work. Already delivered text cannot be recalled. Refused work is not resent automatically when a rule is loosened.
- Disable/remove the target rule to restore future peer admission. Keep delivery/refusal history; no replay of failed/uncertain work, no changes to Hub sharing consent, contact windows, profiles or forwarded human authority.

## 5. Proposed acceptance before any implementation lands

Fail-first cases: same-team and outside-team callers to locked targets; all five tool names and raw send kinds; General and coordinator with no role bypass; Classic source/target; external aliases and spoofed `senderSessionName`; profile intersections; partial broadcast; queued revocation after idle wait; duplicate and restart recovery; denied-forward grant absence; forged report correlation; blocked delegate return path; allowed/invalid Hub answers while M-3160 is active; human channel/owner recovery unchanged. Any new lifecycle binding must be tested on deletion/replacement. These are future acceptance requirements, not claims of implemented checks.

## 6. 給使用者的建議與待選項

現況已用原始程式與隔離測試確認：一般 Agent、協調者、General、ClassicBot 之間沒有收件人名單限制；五種工具都能送。團隊只是分組與群發對象，不是權限邊界。Hub 提問的限制是另一件事：回答期間禁止對外聯絡，最多三十分鐘，但不會擋別人送進來。

建議先做「指定收件 Agent，只接受選定 Agent 的訊息」，例如保護 General 或協調者；其他 Agent 維持今天的行為。五種工具一視同仁，不能改用回報工具就繞過。設定放在 Settings 與 fleet.yaml，預設不替舊 Fleet 上鎖；儲存前列出哪些派工回報會被擋。這主要防止不相干或被帶偏的 Agent 打擾、指揮重要 Agent，不代表收到的訊息就有人的授權，也無法隔離同一個作業系統帳號下的惡意程式。

請使用者決定：

1. 第一版先保護指定收件人，還是確實需要阻止任務內容外流，因此也要「可寄給誰」？後者才需要較大的雙向名單。
2. General／協調者要讓哪些 Agent 主動聯絡？不建議只照團隊自動封鎖，因為跨團隊派工本來就常見。
3. 第一版把接案的工作 Agent 加進收件名單是否足夠？若希望只准它交回某項派工結果、不能主動開始別的話題，再另外做有真實派工紀錄綁定的單次回報通道，不能只信 correlation ID。
4. 這份新名單是否只由人在 Settings／fleet.yaml 管理，連 General 也不能自行改？這會是對 General 管理員定義的明確例外，需要人決定，不能暗中改掉。

在使用者選定前，只保留本設計與證據，不開 PR、不改正在跑的 Agent 或設定。
