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
| Local daemon MCP | daemon/socket or native pane lease | Capture at the first owned IPC hop on the CLI host, synchronously on arrival, before handleToolCall |
| Windows exec | Per-turn NativeMcpRegistry grant: instance/requestId, policy, expiry, stillCurrent | Resolve the admitted input at claim, apply C's eligibility rules, then freeze it into that run's grant |
| Persistent Windows pane | hostBootId/paneId/launchId/agentId/instance plus helper/call ids | Stamp at the first owned relay hop on the CLI host before body/relay waits; Fleet checks the original snapshot |

Source ports: `Daemon.handlePaneToolCall` / `handleToolCall`,
`NativeMcpRegistry` issuance and `dispatcherContext`,
`nativeAgentAdmissionContext`, `PaneMcpAuthorityLease.handle`,
`runtime-pane-mcp-protocol`, and the runtime client/coordinator/bridge relays.
Existing policy/sandbox/dashboard/tool checks stay in each currentness predicate.

## Immutable call contract

The server owns a v1 call binding: stable call key, operation id, exact tool/args
digest, C turn token, context/root references and full runtime owner. The raw C
token remains Fleet-side; an opaque proof derived from token and exact launch
owner crosses the link. Runtime
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

The uniform rule is: capture at the first AgEnD-owned hop on the CLI host,
synchronously on arrival. This closes later body-read, relay and coordinator
delay. It does not prove the interval before that first hop.

Mint the Fleet-side snapshot/proof in C's final beforeWrite/bindRequestContextWrite
under the pane-write lock. An HMAC over the token and exact launch owner is an
appropriate opaque proof; never send the raw token. Carry it on the C-bound input
write frame. The pane host installs it before writing input bytes. A steer joining
the same turn gets the same token, so reinstalling is idempotent. C still refuses
queued input until positive consumption is supported.

On a remote pane, PaneMcpRelay.handle resolves the launch from the existing auth
header and freezes its installed proof immediately after pending increments,
before the asynchronous body read. Carry that stamp on the pane-host/coordinator
MCP frame. Do not reread a newer proof after body or link waits. PaneMcpBody, the
helper connection file and old helpers need not change. On a local daemon,
capture in the IPC message handler before handleToolCall. At Fleet, require C's
isCurrent on the original snapshot/owner; unstamped scoped calls are refused.

Windows exec has no C input binding today. At fleet-windows-runtime.claim, resolve
the delivery's admitted input through ports.input(inputId), applying C's same
independent/expected-return/steer rules. Defer an independent input while another
context is active. Freeze the selected snapshot in the per-run grant session;
the activeId/requestId predicate and nativeAgentAdmissionContext closure retain
it across waits. Do not add a mutable context getter. The per-run bearer itself
identifies the run, unlike a persistent launch-wide helper.

The existing helper/call-id replay identity must pin the original context and
operation. Compare the new arrival's context/proof beside the existing argument
digest check, BEFORE returning previous inFlight/results. A same-key different
proof conflicts instead of receiving A's cached result. A restart/reconnect cannot recreate an active capability
from historical context. An old committed result stays bound to its original
operation; there is no automatic replay of pending/uncertain effects.

The persistent pane ledger is the coordinator-side per-launch launchId.mcp.json
file owned by PaneMcpAuthorityLease. Keep version 1 and put an optional context
reference on its prepared Call row in the SAME atomic save before run. The new
reader validates it strictly. A missing field remains legacy and cannot acquire
a context. The old reader preserves unknown fields and never re-dispatches a
previous row; test that downgrade rather than bumping the ledger version.

Store only contextId/rootContextId/proof digest, never full RequestContextV1 or
actor/user ids: this ledger must retain no plaintext user input. C retain commits
the context before calls can be stamped, so no cross-store atomic transaction is
needed. The drain contract retains referenced contexts until the live launch
ledger is retired. Exec session.calls is in-memory per grant; restart drops the
session and nothing replays.

## Interrupted-launch fallback (decision)

The CLI-to-first-hop interval is not proven or bounded by this design. For
example, A is transcript-aborted while a tool line is still in helper stdio or
HTTP connect; B's proof installs before that line reaches the relay, which would
stamp it B. The same local-hop limitation must be stated for local daemon IPC.
Exec's per-run bearer has no corresponding lookup ambiguity.

The leader chose not to accept that residual. An interrupted/aborted turn followed
by a new independent input on the same persistent launch is not covered until a
fresh launch or originating per-turn helper identity supplies the missing proof.
Persistent covered-publication remains OFF. The per-run exec path is independent.

Not-covered is request-scoped, not an agent lock: an affected contact falls back
to one held operation/card with approve-once/decline, using the agreed Phase 1
experience. Retain its operation identity across retries so there is one decision,
not a card per transport attempt. Do not write an unknown lifetime origin, stop
the agent, or prevent unrelated new work/status/read operations. Approval releases
the exact shown request; it does not erase the coverage gap, replay another held
operation or infer that unrelated calls share its D1 release. Proven descendants
of that approved request retain the normal D1 rule.

The server reason is interrupted-launch, carried as provenance/coverage data,
not human authority and not an invented owner identity. Required card copy names
the sending agent:

- EN: "{source} was interrupted; this contact needs one approval."
- zh-TW: "{source} 曾中斷執行；這次聯絡需要核准一次。"

The central gate/card slices must consume this reason on the same held card;
there is no separate approval workflow. A separate follow-up will add originating
per-turn helper identity and remove this fallback when positively covered.

## Queued input and capability negotiation

Enqueue, Enter-written and delivery acceptance are not consumption. A queued
outside-independent input waits until its owned turn can be proved. A permitted
steer consumed into an existing turn retains that turn's context. Bind from the
positive owned-consumption event before enabling its tools; never switch context
on a queue timer or arrival of a tool call. Ambiguous/missing evidence stays closed.
The end-proof dependency is also a cutover gate: C retires only a matched current
transcript ended/aborted/error verdict with an owned end anchor. An unanchored
turn otherwise holds the next independent input indefinitely. Provide positive
end coverage or keep that path unavailable; idle/window settlement and answer
publication are not substitutes.

Recognize a bounded v1 runtime capability separately from readiness. Advertise or
require it only through the internal rollout port; OFF emits no new capability.
Both runtime and Fleet must negotiate the new C-bound input-write field and the
pane-host MCP stamp field before emission. Both frame schemas are strict: old
peers must refuse, not silently drop a field. Neither field is emitted while OFF.
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
mid-turn steer retaining A, and ambiguous consumption refusal. Also force a relay
body wait across B's installation (the request retains A), unstamped ON refusal,
same-key/different-proof conflict before cached return, v1-ledger downgrade load
with no dispatch, and an exec claim deferred behind active independent work. Mutants must turn
these controls red. No live Fleet, real account/provider/model, or Windows host
operation is authorized by this note. Fable reviews design and implementation.

## Rollback and review disposition

Before cutover, revert the dormant integration without migration. After activation,
keep A's barrier and drain/cancel dependent work before downgrade; do not discard
call provenance to make an old peer work. Existing committed effects remain
recorded, and unknown outcomes are never retried automatically.

Fable's source review at the stated baseline resolves mint/stamp and ledger
placement as above. Its exec-input source, replay ordering, end-proof dependency,
two-sided strict negotiation and five additional synthetic controls are adopted.
The leader selected the interrupted-launch per-operation fallback above, not
acceptance of the pre-first-hop residual or a late central lookup. Implementation review follows on this same PR;
no repeated design, native, browser or provider campaign is requested.
