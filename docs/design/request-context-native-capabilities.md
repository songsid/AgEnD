# Native and paired request-context call capability (slice D)

Design first, following [local turn binding](request-context-local-turns.md) and
[request-scoped contact provenance](request-scoped-contact-provenance.md).
Baseline: release `10cd71cca95b761bf412f384905ed922c78a1035`, including merged C.
No code or capability is enabled by this note. Production remains OFF until L.

## Boundary and threat

The threat is a delayed call from request A being accepted as the newer request B
under the same agent/pane/launch. Transport permission and tool arguments do not
prove the request that owns a call. Context must be captured once at original
owned-call admission, before an await, then retained and rechecked at commit and
response boundaries. A turn change makes that call stale; it never acquires B's
context. Provenance carries no go-ahead or human-receipt authority.

| Path | Existing owner | Required binding |
| --- | --- | --- |
| Local daemon MCP | daemon/socket or native pane lease | Frozen C snapshot at admitted tool entry; original currentness callback through every awaited operation |
| Windows exec | Per-turn NativeMcpRegistry grant: instance/requestId, policy, expiry, stillCurrent | Capture context when that run's grant is issued, not when a later HTTP body finishes |
| Persistent Windows pane | hostBootId/paneId/launchId/agentId/instance plus helper/call ids | Additional originating owned-turn proof; launch identity alone cannot choose a context |

Source ports: `Daemon.handlePaneToolCall` / `handleToolCall`,
`NativeMcpRegistry` issuance and `dispatcherContext`,
`nativeAgentAdmissionContext`, `PaneMcpAuthorityLease.handle`,
`runtime-pane-mcp-protocol`, and the runtime client/coordinator/bridge relays.
Existing policy/sandbox/dashboard/tool checks stay in each currentness predicate.

## Immutable call contract

The server owns a v1 call binding: stable call key, operation id, exact tool/args
digest, C turn token, context/root references and full runtime owner. Runtime
links additionally bind machine, connection generation and pane/run owner.
Models supply none of these through tool arguments. The call binding is not
placed in the human authority field or sent as a human receipt.

Capture once, before asynchronous dispatch. A closure/proxy carries that original
binding into delivery, task and other commit guards. It must not call a mutable
"current context" getter to reconstruct the request after an await. Recheck the
original binding before dispatch, after awaited validation/staging, immediately
before side effects, and before writing the response/receipt.

If the effect committed before currentness was lost, preserve its operation/result
record. A stale response is unconfirmed, not permission to undo or resend it.
The caller inspects the original operation through existing status controls.
Sibling or new-turn callers cannot receive authority from an earlier result.

## Originating pane proof and replay

Persistent pane MCP currently has no per-request context in its strict wire
schema or replay ledger. Capturing the Fleet's current turn only when a delayed
HTTP/remote request arrives is unsafe. D must not implement that shortcut.

A covered producer must carry a server-issued, opaque owned-turn/call proof from
its originating request admission, before relay waits. Its issuance must be tied
to actual owned input/turn evidence, not launch identity, a pane screenshot, text,
correlation, or an Agent-selected id. The runtime/helper must preserve the captured
proof across the trip. If the current producer cannot supply that proof, that
scoped path remains not-covered and is refused; it is not assigned an owner root.

The existing helper/call-id replay identity must pin the original context and
operation. Replaying the same call under a different turn conflicts even when
arguments are identical. A restart/reconnect cannot recreate an active capability
from historical context. An old committed result stays bound to its original
operation; there is no automatic replay of pending/uncertain effects.

Any new proof record must be committed with the native call ledger (an additive
column/companion under its transaction), not inserted into older strict journal
JSON. The compatibility/drain contract must cover the retained reference. Do not
claim atomic capture if the two records are in separate independent commits.

## Queued input and capability negotiation

Enqueue, Enter-written and delivery acceptance are not consumption. A queued
outside-independent input waits until its owned turn can be proved. A permitted
steer consumed into an existing turn retains that turn's context. Bind from the
positive owned-consumption event before enabling its tools; never switch context
on a queue timer or arrival of a tool call. Ambiguous/missing evidence stays closed.
The generalized backend-completion gap noted in C remains an explicit cutover
gate; idle/window settlement and answer publication are not substituted for it.

Recognize a bounded v1 runtime capability separately from readiness. Advertise or
require it only through the internal rollout port; OFF emits no new capability.
Both runtime and Fleet must negotiate before any scoped remote path is enabled.
Unknown/missing versions refuse the affected operation with a concrete coverage
reason. Old frames keep their legacy behavior only while the new flow is OFF.
No new CLI launch refusal or sandbox claim is implied by this protocol fence.

## Implementation and verification plan

1. Add immutable call-capture/currentness primitives and bind native exec grants
   and local tool entry. Route the original snapshot through existing admission
   proxies, without new tool parameters or mutable global per-call context.
2. Extend the pane/runtime proof and replay contract only where the originating
   producer can prove ownership. Preserve strict old-peer rejection and current
   owner/policy checks. Unsupported producers remain closed, not guessed.
3. Join positive queued-consumption evidence to C without treating enqueue as
   actual input. Keep publication/readiness OFF until the complete matrix exists.

Synthetic controls: hold A's awaited validation, end A/start B with identical
transport owner, then prove zero A side effects under B; positive A completes
once. Check task and delivery commit guards, response-written fences, role/config
revocation, reconnect, call-id/context conflicts, lost ACK and no replay. Include
old-peer negative plus OFF positive, queued-before-consumed refusal, permitted
mid-turn steer retaining A, and ambiguous consumption refusal. Mutants must turn
these controls red. No live Fleet, real account/provider/model, or Windows host
operation is authorized by this note. Fable reviews design and implementation.

## Rollback and review questions

Before cutover, revert the dormant integration without migration. After activation,
keep A's barrier and drain/cancel dependent work before downgrade; do not discard
call provenance to make an old peer work. Existing committed effects remain
recorded, and unknown outcomes are never retried automatically.

The design review must settle two concrete details before protocol implementation:
(a) which originating pane event can mint the owned-call proof, since the current
wire owner is launch-scoped; (b) which existing native ledger transaction owns the
context reference so retry/crash capture is atomic. A late central context lookup
or independent best-effort metadata write is not an acceptable fallback.
