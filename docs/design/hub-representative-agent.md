# Hub P1: representative agent

Status: design note for experimental alpha, following approved decision **f619f813** (2026-11-06). Implementation follows review. `hub.enabled` and `hub_member.enabled` remain off by default.

This replaces the restricted-outbox/isolated-context prerequisites in [hub.md](hub.md) §§2, 3 and 5, its S4 acceptance row in §6, and the member execution/data-view prerequisites in [composition](hub-composition.md) and [S3c](hub-s3c-exposures.md), for P1. Signed identity, grants, owner consent, journal evidence, exact authorization leases and audit remain. The isolated [S4](hub-restricted-execution.md) and [container provider](hub-isolated-provider.md) retain their own contracts but are off and uncomposed in P1.

## Existing agent, existing conversation

The owner selects an existing fleet agent. Hub questions reach it through normal cross-instance delivery, like messages in a ClassicBot room. It uses its normal Claude Code or Codex login, working folder, conversation and Settings tool set. There is one conversation per representative agent: all askers share that agent's ordinary context. The folder supplies its working context; no new read-only or filesystem-confinement guarantee is added.

The owner can choose an existing restricted tool set, such as worker/minimal, in Settings. Actions requiring local approval continue through the CLI's existing prompts and the owner's Needs-you. No new permission configuration, credential handling, sandbox or per-asker sessions are introduced. The representative uses the installed CLI normally; this mode requires neither Docker nor an API key and changes no CLI update policy.

[Approved roles](hub.md) still apply: the Hub “runs no agents”; “its owner chooses which agents, data views and tools other people may use”; an asker needs “a browser and a grant”. Hub-verified asker identity is provenance data, never member-local human approval. The delivery label identifies the Hub and verified asker, without a `[user:… via …]` human-authority header. Hub administrators and askers cannot approve local actions.

## Picker and consent

S3c's exposure picker lists configured instances accepted by normal delivery, including General. The dedicated Hub daemon is not a fleet instance and is absent. The owner picks an agent instead of document views or Hub tools; its folder and tool set stay in ordinary Settings.

Keep the v1 exposure wire shape. The representative descriptor is exactly:

| Field | Value |
| --- | --- |
| Member-local `providerId` | `"agent"` |
| `dataViewId` | `"agent"` |
| `allowedTools` | `[]` |
| `policyDigest` | `sha256(canonicalArguments({mode:"agent", agent}))` |

`agent` is the stable local instance name, not its display label. The empty list means no Hub-delegated tool phases; the ordinary agent still has its current Settings tools. Reuse `identity.ts` canonicalization and hashing.

Keep local-owner confirmation, stage → readiness → recheck → atomic publish, revision CAS, consent ID, audit, snapshot and immediate withdrawal. Candidate readiness checks the configured target and exact descriptor; it grants no consent. Question handling reads only committed, published mappings at the signed revision, matching owner/fleet and current agent lifecycle. Replacement, retargeting or mode changes fence old bindings and require explicit republish.

Legacy container rows remain durable and withdrawable. Show `republish_required`; never convert them silently. Explicit republish creates a new revision and consent through the existing CAS path. Preserve DTO/error shapes, including `policy.tools: []`. Old tabs requiring a nonempty tool list cannot publish; new lazy copy owns a fallback for cached strings.

## Delivery, answer and composition

S5 composes exactly one execution path: a separate representative adapter. Old `hub_member.execution.provider` configuration is ignored with one informational log, without a hold or fallback. No S4 service/provider is constructed. The container code remains in the tree, unoffered and off in P1; enabling it later needs a separate decision.

S1 admission and the member journal stay in place. The adapter synchronously inserts/looks up a unique `hub:<hubId>:<messageId>` source row in the journal's same SQLite transaction, checking the exact question and representative binding. Only after commit does it call `FleetManager.deliverToInstance`. Update S1's restricted-only outbox/admission comments for this approved adapter; never cast an ordinary agent into S4's `readOnly:true` interface.

One optional `DeliveryOptions.beforeInput` async hook runs after wake, idle wait and storm recheck, immediately before IPC hand-off. It rechecks consent/lifecycle, obtains the exact current begin lease and persists `markInputIntent`; false sends nothing. The existing idle gate can hand off to a busy CLI after its backstop. Reconnection can also delay hand-off. Queue acceptance alone is not delivered/consumed evidence. Interrupted or uncertain hand-off holds in Needs-you and is never blindly resent.

Use the existing cross-instance response path: `report_result` (or CLI-mode `agend-agent report`), with a Hub-issued correlation ID. A small outbound hook accepts only the reserved Hub target, a live unanswered/unfenced correlation, and its designated caller, consuming it once. It binds the exact source/dispatch even for a later queued turn; it never chooses the latest question implicitly. Ordinary `reply` keeps its own chat route.

Actual delivery/reply evidence advances the journal. Freeze answer ID, bytes and digest before exact release-answer authorization; recheck current exposure/link/revocation and save the answer/receipt before routing it back. Revocation fences unsent work and answer disclosure; it cannot erase input already in the shared conversation. Existing transactional Hub/member audit records every Q&A and refusal. Required audit failure prevents successful admission or disclosure.

## Small acceptance and ownership

Use real installed Claude Code and Codex in the existing isolated rig, with mock model APIs and dummy credentials, never real accounts or a live fleet. For each backend: (1) publish an agent, observe the question in its normal CLI, return a correlated answer to the Hub and inspect audit; (2) withdraw, ask again and verify refusal with no CLI delivery. These prove integration, not subscription authentication. No container-provider P1 run or new credential/sandbox matrix is required.

A focused adapter fixture covers a legacy tuple refusing delivery, an old provider block leaving agent delivery available without constructing a provider, and wrong/duplicate reply correlation. Reuse existing journal/lease/revocation tests. S3c owns picker/store compatibility; S5 owns composition, the delivery hook, representative outbox and answer bridge; S1 coordinates its contract wording. Implementation PRs follow this note's approval and post exact-head acceptance before parity review.
