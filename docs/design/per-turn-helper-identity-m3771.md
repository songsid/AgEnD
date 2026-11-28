# Per-turn helper identity for persistent calls (M-3771)

Design for review. No implementation or coverage publication is enabled by this document. The Leader approved design first, Fable review, then three implementation slices. Code PRs stay on HOLD **after 2.4.0**; this document may merge independently.

This extends [D's native capabilities](request-context-native-capabilities.md) and the [request-scoped model](request-scoped-contact-provenance.md). It does not change contact policy, human authority, the existing On switch or the meaning of capable Off.

## Outcome and boundary

An interrupted turn A must never make a later tool call with turn B's identity. B can regain positive coverage when its own origin is proven, without clearing an agent's history or declaring the whole launch trustworthy again. A backend without that proof retains the existing one-operation approval fallback.

Two distinct proofs are required:

1. A provider-owned input event binds an exact admitted input to a provider session and turn, under the actual launch owner.
2. Each tool invocation carries that originating identity from the provider, before it can wait in stdio, an HTTP connection, a relay or Fleet IPC.

A transport bearer authenticates a helper launch. It does not create either proof. A prompt token that the model is asked to repeat, a current-turn file, JSON-RPC sequence number, timestamp, argument hash, idle observation or latest transcript turn cannot substitute for them.

### The failure being closed

| Event | Existing first-hop stamp | Required origin-bound behavior |
|---|---|---|
| A creates a call; its bytes wait before the helper/HTTP arrival | No stamp yet | The provider has already attached A's immutable identity |
| A aborts; B is delivered on the same persistent launch | The launch now has B's stamp; interruption fallback remains sticky | A's binding ends; B gets a separate proven binding |
| A's delayed call arrives | Looking up the installed stamp could name B | Read A's carried identity; refuse dispatch under the ended binding |
| B's call arrives | The old path stays uncovered after interruption | Resolve B's own registered origin and run normal C/D checks |

No timer or empty in-flight registry proves that the CLI has no earlier buffered call. There is no semantic claim that a model forgot old instructions.

## Source inventory

AgEnD baseline: release commit `0ae5594d2eee1fdf38f1fc0b42569bb98b981d85`, including L's merge `785849ac`.

| Path | What the existing source proves | What it does not prove |
|---|---|---|
| Local helper | `channel/mcp-server.ts` captures `AGEND_LAUNCH_TOKEN` once, authenticates its IPC connection and forwards tool arguments with a request/operation id | Its current handler does not carry a provider turn or native call id |
| Local daemon | `beginRequestContextCall` freezes C's current snapshot at IPC arrival | Which provider turn created a call delayed before that arrival |
| Persistent Windows helper | `windows-pane-mcp.ts` loads a private launch connection once and frames stdin; `windows-native-mcp.ts` derives transport call ids | The originating turn of a frame or connection delayed before the relay |
| Pane host/relay | C's stamp is installed before the final PTY write; relay arrival freezes it before reading the body | A tool call's origin before relay arrival |
| Exec | `fleet-windows-runtime.ts` binds a distinct grant to one owned execution | No change is needed: this is already a per-run bearer, not a persistent-turn lookup |

The existing Claude session hooks and static MCP configuration for the other backends do not provide a cross-boundary turn join in AgEnD today. That is a statement about current wiring, not a claim that those providers can never expose one.

## First producer candidate: Codex

The first adapter is proposed for the **source contract** in official Codex release `rust-v0.172.0`, commit `3d86e43b075adeba2193ec5c22ac92f55afd82e6`. This is an audit target, not a claim that an installed binary was tested or that every later version is compatible.

The actual [MCP producer](https://github.com/openai/codex/blob/3d86e43b075adeba2193ec5c22ac92f55afd82e6/codex-rs/core/src/mcp_tool_call.rs#L1526-L1567) supplies `callId` and `x-codex-turn-metadata` in request metadata. The [dispatch path](https://github.com/openai/codex/blob/3d86e43b075adeba2193ec5c22ac92f55afd82e6/codex-rs/core/src/mcp_tool_call.rs#L600-L674) constructs metadata separately from model arguments. The [custom-server test](https://github.com/openai/codex/blob/3d86e43b075adeba2193ec5c22ac92f55afd82e6/codex-rs/core/src/mcp_tool_call_tests.rs#L1288-L1355) checks that an ordinary MCP server receives those fields. This is not inferred from an API request header or a consumer plugin.

A provider-owned [UserPromptSubmit event](https://github.com/openai/codex/blob/3d86e43b075adeba2193ec5c22ac92f55afd82e6/codex-rs/core/src/hook_runtime.rs#L709-L740) supplies the actual user input together with the session and turn ids. [Serialization](https://github.com/openai/codex/blob/3d86e43b075adeba2193ec5c22ac92f55afd82e6/codex-rs/hooks/src/events/user_prompt_submit.rs#L81-L95) preserves them; [turn construction](https://github.com/openai/codex/blob/3d86e43b075adeba2193ec5c22ac92f55afd82e6/codex-rs/core/src/session/turn_context.rs#L1138-L1145) initializes MCP metadata with that same identity. [Input processing](https://github.com/openai/codex/blob/3d86e43b075adeba2193ec5c22ac92f55afd82e6/codex-rs/core/src/session/turn.rs#L1155-L1198) awaits the hook. The managed hook must be synchronous. Reserved session/turn metadata is [filtered from caller extras](https://github.com/openai/codex/blob/3d86e43b075adeba2193ec5c22ac92f55afd82e6/codex-rs/core/src/responses_metadata.rs#L569-L576).

### Coverage matrix

| Producer and path | Initial treatment | Gate before positive coverage |
|---|---|---|
| Codex, persistent local | Candidate adapter, dormant | Authenticated synchronous hook, exact input-image join, native MCP identity, supported codec and current owner |
| Same Codex contract, persistent Windows pane | Same producer contract; separate host transport gate | The same join on the owned CLI host, plus bilateral runtime negotiation and immutable forwarding |
| Claude Code | Existing fallback | A separately reviewed provider-owned input/call join; session id alone is insufficient |
| Kiro, Grok, Muse, OpenCode, Antigravity | Existing fallback | Equivalent source evidence, fixtures and an adapter; no generic current-turn stamp |
| Existing per-run exec | Existing D behavior | Keep the run grant and existing currentness/once-only rules |
| Missing/changed producer contract, old helper or old peer | Existing fallback or protocol refusal | Never advertise coverage from a version string or helper presence alone |

No producer is positively covered merely by this design or by a helper advertising a new decoder. Each call needs the actual matched evidence below. Other backends are not silently enabled with the Codex parser.

## Exact input-to-origin registration

Add a managed, launch-authenticated **input-origin observer**, separate from the MCP tool menu. It has no tool action that the model can invoke to register an origin.

1. C's owned final-write path records the exact admitted input identity, complete delivery image digest, actual formatted wire image, source owner/generations and bound C snapshot. A queued input is not a consumed turn. A permitted steer keeps C's existing provenance.
2. The managed synchronous provider hook receives the provider-native input event. It connects through a private endpoint using a role-bound launch credential. Keep observer and helper credentials separate, but do not assume either is secret from the model: the hook and model tools may share uid, environment and files. A valid observer credential binds the launch, not the truth of a registration. Local sockets and Windows host-local endpoints use the same exact launch-owner check as their helper paths. A payload-provided actor, environment name, cwd or provider id never selects the owner.
3. A provider-specific pure codec computes the expected hook input from the admitted provider input image. It must match the complete image, not a prefix, text inside an assistant message or the newest pending input. Exactly one current eligible receipt may match. Zero or multiple matches remain uncovered.
4. Persist an immutable association from the provider origin to that exact C token/context/input evidence before acknowledging registration. The observer may resolve only previously retained contexts. Registration alone grants no human authority, delivery receipt, end proof or side-effect permission.
5. At tool creation, the provider attaches its own origin and native call id. The helper captures those fields from that individual MCP message before any asynchronous IPC/HTTP work. It never loads a mutable current-origin pointer.
6. The receiver resolves only that carried origin association, then applies C/D currency, owner, role and per-operation policy at the existing dispatch/commit boundaries.

The hook is new work; AgEnD currently authenticates MCP helper launches, not this input hook. Do not reuse a tool callback, accept arbitrary hook JSON over an unauthenticated port, or treat a successful process spawn as hook authentication.

The synchronous registration wait has a bounded local budget; it never waits on a model or remote account. Failure leaves the operation uncovered, not the user input blocked: the managed hook must not reject ordinary chat merely because the observer is unavailable. No new ingress approval is introduced. A registration retry is idempotent input bookkeeping, never a pending tool replay. A timeout itself is not proof; only a validated retained association can later supply coverage.

### Canonicalization is a coverage gate

The cited hook joins user text fragments and does not identify every nontext component. Equality with a TUI paste is not established by reading those field names.

The first codec must audit and fixture the actual interactive input transformation. Start with the text-only subset whose entire transformation is proven. Do not add trimming, whitespace collapsing, timestamp matching or ad-hoc newline tolerance to make a failed join pass. If native images, files, slash expansion or omitted components cannot be bound to the complete admitted image, those inputs remain uncovered. Two inputs with the same visible text and different files must not share an association.

The diagnostic `transcript-records.ts` parser currently associates user records with an `openTurnId`. It is not the input authority for this design. Only the provider-owned hook/native admission relation qualifies; a later transcript can corroborate it without inventing the join.

### Receipt consumption and adversarial registration

The observer must remain safe when a model can read its credential and send registrations. Authentication alone cannot establish that the caller was the managed hook.

- **One receipt, one origin:** the first accepted association consumes an admitted C input's evidence for exactly one provider session/turn. A different session/turn naming that same evidence is a conflict, is logged without plaintext input, and never creates or replaces an association.
- **Registration window:** open only at C's owned final write of the exact input. Close at the first carried-origin call consuming it or the input's end, whichever comes first. An exact retry may read the same retained association; it cannot reopen a consumed window.
- **Real call identity:** dispatch still requires provider-attached metadata, not an observer-supplied turn id or a model argument. An observer request never grants authority by itself.
- **Sealed boundary:** receipt exclusivity and the window are not sufficient on their own. Positive coverage also requires the closed-boundary rule below; neither credential possession nor winning the first registration proves that the native turn belongs to the later input.

Slice 1 must include the readable-key adversary: seed the observer credential in model-readable state, establish B's real association, then submit a competing registration for that receipt with another turn id. Expect a conflict and B's original association unchanged. Also test a competing first claim after an earlier hook failed; positive coverage cannot depend on first-writer timing alone.

### Coverage requires a sealed boundary

Before C admits an **independent** input on a launch, seal every earlier provider turn C can name: turns named by an owned native end/abort record, turns observed in carried call metadata whether covered or not, and registered turns whose execution ended. Tombstones are launch-scoped. A registration naming a sealed session/turn conflicts, is logged, and never creates or replaces an association. A later registration cannot resurrect it.

If an earlier turn ended without a proven origin and no owned native end evidence names its id, the boundary is **unsealed**. A failed input hook plus an unknown A is this case: A's model process may outlive abort and compete for B's receipt with its real A id. Do not let B's registration grant positive coverage or associate that receipt to A. B's ordinary input still proceeds on the existing uncovered, per-operation contact fallback; A's delayed call cannot dispatch as B.

Resume positive coverage only at the first later input admitted after a **proven clean boundary**, where every earlier turn is immutably registered or sealed. A permitted steer does not manufacture a new independent boundary or change its existing C provenance. There is no timer, fixed input count, empty-call-map test or “one fallback happened” shortcut. If an older unidentified turn still lacks the required evidence, keep the per-operation fallback until that evidence or an owned fresh launch makes the boundary provable. This changes coverage, never the agent's lifetime permissions or ordinary input admission.

The normal synchronous hook runs before its input is processed, but the protocol must also handle a failed hook without relying on hook secrecy or first-writer-wins. Seal facts and the unsealed-boundary flag are retained/revision-counted with F's launch records. They survive transport/helper reconnects and retire only with that exact launch; no pending call is replayed to reconstruct them.

While its registration remains eligible, an exact retry of the same origin and evidence is idempotent; a sealed origin is always refused. An existing origin cannot change C token, owner, input image or lineage. A steer/additional input may join only if C already admitted it to that exact existing turn; it cannot promote an outside root to owner work. Independent inputs get their own proven origins. A conflicting, missing or ambiguous registration never attaches to a later turn.

## Identity and transport contract

Proposed internal capability: `helper-origin-v1`. It is separate from launch authentication, C/D stamp negotiation and tool permissions. Backend adapter, helper, daemon and actual remote host/coordinator must agree before a covered origin is emitted or consumed. A source version is a compatibility prerequisite, not proof of registration or readiness. Decode both hook payloads and MCP metadata strictly against the audited runtime schema on every relevant event. A changed shape makes that turn uncovered; it does not put the entire launch into an error state.

An origin reference binds:

- provider codec/version and the exact current launch owner;
- provider session/thread and turn identity;
- the C token/context and exact admitted-input evidence digest, held server-side;
- the provider-native call id and the full canonical operation image digest for each invocation.

Provider identifiers travel only through the private owned transport. Use launch-bound opaque keyed digests for durable references; do not persist plaintext prompts, tool arguments, account identities or bearer secrets. A MAC binds already-proven facts; it cannot turn a model-chosen id into provider evidence. Never send C's raw token to the model or put a proof in a tool argument.

Local IPC adds a strict origin field on the authenticated helper frame. Windows pane calls add the same semantic reference to the strict helper/host/coordinator frames. Preserve it unchanged through framing, HTTP connect/body waits, relay queues and Fleet IPC. The new path resolves the carried origin instead of choosing the launch's latest installed stamp. Existing stamp publication remains for old paths; its sticky interruption state is not cleared globally.

A new helper on an old producer cannot claim coverage. A peer missing the required schema refuses the covered frame; it must not strip the field and dispatch through the legacy path. Do not hot-upgrade or downgrade a live launch's coverage contract. A newly negotiated contract belongs to a positively owned fresh launch; existing retained panes stay on their known contract until normal owned relaunch. No extra automatic agent restart or new user setting is introduced here.

## Call identity, once-only behavior and responses

There are two identities: an operation's stable native identity and a transport attempt's helper/RPC identity. They must not be conflated.

For a covered producer, derive the stable call key from the exact launch, provider session and provider-native call id. Bind its turn/origin and full operation digest on first preparation. The turn is a compared proof field, not a way to create a new call key after a conflict. A repeated native call id with a different origin or image conflicts before any cached/in-flight result. Do not assume RPC numbers survive helper reconnects or use an IPC counter as native identity.

The key-to-operation-id mapping is prepared durably **before invocation**. An exact retry shares the original in-flight/result record; it never issues another effect. Restarted readers retain prepared/done identities but do not re-dispatch pending calls or reconstruct a result by invoking the tool again. Unknown outcomes name the operation and say not to repeat it.

Reuse D's prepared/done/written call-record mechanism and comparison ordering. The Windows launch ledger keeps its version-1 compatibility container. Put a strictly validated optional origin reference beside the existing `requestContext` field, not inside that field's closed schema. Local calls need the same durable preparation semantics under their real local launch owner; factor the shared record mechanism rather than fabricate pane owners or build a second permission/relay engine.

A resumed provider session may reuse its session id across launches. Launch identity is always part of the key: the same session/native call id on a new launch is a distinct key and never adopts an old pending row.

A new logical call-key codec is namespaced and explicit. Legacy rows are never adopted as covered rows. Transport aliases bind to the original stable call, response id and origin digest. All comparisons precede cached and in-flight returns. Capacity refuses safely; it does not evict an old identity and infer a replacement from current context.

A stdout response ACK is not a new operation. Match the original durable row, response id, origin reference and current launch transport. A late ACK for A may mark A written after A ends; it cannot use B's origin and need not re-resolve a current turn. Preserve D's post-commit uncertainty wording and current-role checks for actual dispatch. No retry policy is broadened for ended turns.

## Lifecycle, retention and fallback

Origin associations are launch-scoped, immutable and revision-counted. They participate in F's actual drain inventory together with active calls and durable call records. A referenced context cannot be collected before its launch/call records retire. Retain origin associations and call rows with the launch records until F proves the launch and its referenced work retired; never age-prune a referenced row. Use a shared per-launch bound of 4,096 origin associations/tombstones; retain the current call-ledger bounds of 65,536 rows and 16 MiB serialized data, whichever is reached first. Refuse new covered preparation rather than evict. A long-lived launch reaching capacity stays on its existing recorded work and per-operation failure/fallback behavior, never an unbounded store or Fleet-wide lock. Abort/end retires execution eligibility, not the evidence needed to reject a delayed call or accept its original ACK.

- A late A call resolves A and cannot dispatch after its currentness ends. It is not relabeled as an unproved B request.
- A positively registered B call can be covered without clearing the launch's interruption history for untagged calls.
- An old/unsupported helper stays on the existing uncovered path: one operation id, one held contact card, Continue/Decline, no standing grant for an unknown requester and no lifetime-origin write.
- Recognized stale/conflicting origin data refuses; it does not mint a fresh operation or a fresh approval to repeat a possibly completed effect.
- Missing evidence on an explicitly uncovered path retains the existing `interrupted-launch`/`unbound-input` treatment and EN/zh copy. There is no new ingress approval card or global lock.
- Tool arguments, forwarded receipts and labels still grant nothing. Current source access, target administrators, incarnations and C/D ownership are rechecked as today.

Fresh helper/transport reconnects can carry the same provider-native operation only within the unchanged authenticated launch and registered origin. An owner/launch/session change cannot adopt old pending work. Cold recovery remains unendorsed when its parent is unproved; no pending-call replay is added.

## Downgrade and rollback

Before activation, the new protocol is dormant; no new coverage claim is published. After activation, remove coverage only by disabling the producer adapter for new launches or through the existing owned drain/relaunch path. Never switch a live origin-bearing call into current-stamp interpretation.

Mixed helper/daemon/runtime versions fail negotiation or retain the old uncovered behavior. The ledger extension must pass both strict new-reader validation and a downgrade load/no-dispatch test. Additive JSON alone is not a safety proof: test that an old consumer cannot accept a covered new frame, create a fresh legacy operation from it, or replay a retained row.

L's existing data floor, On confirmation, update exclusion and Go back contract remain unchanged. If implementation discovers a stronger persistent compatibility requirement, bring that to design review before adding or raising a floor. A normal process restart does not authorize replay or erase an interrupted origin.

## Required synthetic controls

Every positive must exercise the actual observer → helper frame → receiver binding → existing dispatch gate, not just accept a model-created test field.

| Control | Expected result |
|---|---|
| Whole A line buffered before abort; B input/hook registers before A arrives | A never dispatches as B |
| Partial A line completed after B, or A HTTP connection/body delayed across B | Same original A identity and refusal |
| Valid B input event and native call metadata | B dispatches once with B's C snapshot |
| Exact native retry over a new transport/helper alias | One operation/effect; no pending replay after restart |
| Same stable call key, changed turn/proof, files, forwards or args | Conflict before cached/in-flight response |
| Native input text equal but image/file differs; prompt prefix copied in another message | No association from partial evidence |
| Hook lacks auth, is asynchronous, has wrong owner/session, or matches multiple inputs | No positive coverage/current-context lookup |
| Model-readable observer credential submits a second origin for B’s consumed receipt | Conflict; B’s first valid association remains unchanged |
| A hook fails, A aborts without named origin evidence, and forged A races B’s registration | B remains uncovered; A cannot dispatch as B or acquire B’s receipt |
| A sealed native session/turn is registered again | Conflict; no association or resurrection |
| Abort has owned native end evidence, followed by a clean-boundary input | Its new registered origin can be covered; old A remains sealed |
| Hook/MCP metadata changes from the audited schema | That turn uncovered; launch continues |
| Fake origin in tool arguments or unregistered metadata | Never becomes native origin |
| A stdout ACK after A ended, or B supplies A's response id | Exact original ACK accepted; mismatched one refused |
| Demotion, incarnation change, runtime reconnect or launch retirement during await | Existing currentness/role fence refuses commit |
| Old helper, missing metadata, unaudited producer and old peer | Existing per-operation fallback or strict refusal; no lifetime lock |
| Downgraded ledger reader / producer disabled after restart | Loads only compatible state; no effect replay or origin adoption |
| Resume uses the same session/native call id under a new launch | New key, no old pending-row adoption |
| Codex binary self-updates on disk while a launch runs | Running launch keeps its fixed contract; next launch strictly decodes/renegotiates, never trusts the version string alone |
| Referenced origin/call records age or capacity is reached | No referenced eviction; bounded refusal and launch/F retirement only |
| A normal fresh input follows an uncovered contact | Its own admission works; no agent-wide permission mutation |

Mutation controls remove the input-image join, carried-origin lookup, seal check, unsealed-boundary rule, conflict-before-cache ordering and post-await currency independently; each must fail on an assertion. Tests remain synthetic: no provider login, model request, live Fleet, paired host or native account is started.

## Three implementation slices after review

| Order | Slice | Deliverable and boundary | Review / release |
|---|---|---|---|
| 1 | Provider origin and helper wire (M) | Codex source-pinned codec, role-bound observer, one-receipt/one-origin window, sealed-boundary/tombstone rules and strict immutable helper envelope; no serving publication | Fable; code PR HOLD after 2.4.0 |
| 2 | Local call consumption (M) | Daemon origin resolution, shared durable call-record semantics, exact retries/ACKs/retirement, legacy fallback fixtures | Fable; depends 1; HOLD after 2.4.0 |
| 3 | Windows and coverage (M) | Host observer/strict paired transport, pane ledger integration, full late-A/B matrix and mixed-version/rollback proof; enable only positively covered paths | Fable; depends 1–2; HOLD after 2.4.0 |

Separate PRs start from the merged release tip, without stacking. No new provider is enabled by copying the Codex adapter. No fallback is removed until its actual producer, input join, helper and receiver are positively covered.

### Review questions before implementation

1. Does the synchronous Codex input hook plus provider MCP metadata supply the two native facts required above, with exact normalization and launch authentication still explicit implementation gates?
2. Is the native-call key, separate transport alias and durable comparison contract sufficient without adopting any legacy row or adding pending replay?
3. Does the negotiated fresh-launch boundary plus the existing fallback make downgrade/unsupported paths fail closed without turning the coverage gap into an agent-wide lock?

4. Slice 1 must prove the sealed-boundary branch independently of the observer credential: failed-hook competing registration, sealed-origin rejection and positive recovery after a named native end, with the seal check and unsealed-boundary rule each mutation-killed.
