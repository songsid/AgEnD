# Hub hot-path audit (M-3184)

Scope: Fleet startup through agent tool readiness; MCP/native tool discovery and dispatch; ordinary human/peer delivery; Fleet web shell/status and Hub Settings controllers. Cairn's M-3183/#4004 owns stdio static catalog generation and the shared disconnected-call explanation. This work consumes that change without duplicating its product hunks.

## Call-site inventory

| Entry / chain | Dependency and previous bound | Disposition |
| --- | --- | --- |
| FleetManager.startAll → observeHubSwitches → applyHubSwitches | Mount/recovery/member handshake | Already background: queued microtask with a discarded/handled promise. General/worker startup does not await it. Kept; synthetic-agent readiness guard. |
| MCP tools/list → currentTools | Previously awaited hub_room_status IPC, affecting every tool | #4004 makes listing local/static within role/dashboard policy; no Hub query or connection-change refresh. Actual stdio guard/measurements consume that fix. |
| Native MCP allowed/menu; FleetManager.nativePanes allowed/menu | Local connection predicate hid four tools offline | Removed only connectivity filtering. Role, dashboard, sandbox/read-only and tool-specific limits remain; shared call-time Hub/actor refusal stays authoritative. |
| FleetManager.deliverHumanToInstance / deliverToInstance → local idle/IPC lanes | Local lifecycle and IPC, no global Hub readiness await | Already independent; kept. Measure real local IPC acceptance, not vendor/model consumption. |
| Outbound Hub contact-window policy | Cached local ≤1MiB file / ≤4096 rows; no Hub query | Intentional refusal during an active shared-agent question, not network latency. Existing fail-closed policy retained. |
| Hub-origin representative beforeInput → HubMemberClient.exchange | Authorization before writing the question | Existing 5s RPC timeout, 32 pending limit, disconnect/fence rejection. Security-sensitive hook retained. Same-agent queued work can wait behind this bounded authorization; human/unrelated-agent delivery does not wait for global Hub readiness. |
| HubSocket.send → ws.send callback | No callback deadline; close/retire did not settle waiting sends | Fixed: 5s write budget, bounded outstanding writes, uncertain outcome on deadline/end/retire and late-callback fence. Timeout closes the failed link. Socket acceptance remains non-durable. |
| Member start: TLS upgrade, welcome, reconciliation | 5s upgrade, 5s welcome, 5s exchanges; reconciliation aggregate 30s / 8192 exchanges | Existing finite bounds, retryable-offline start and reconnect backoff retained. The pre-reconciliation fleet.info send now also has the central write deadline. |
| Fleet web request dispatch / shell / status | Local auth/config/cache projection | No remote Hub await found. Keep independent; browser Hub workspace loads separately. |
| Membership/pairing/exposure projections and exposure commits | Local files/store and asynchronous publication | No remote wait on these read/commit paths. Do not add cancellation races to local durable commits. |
| HubRuntime.acquireDirectorySettings / withWebAddressDecision / withMemberAddressDecision | Could await the whole running Hub mount (including member work) | Cold acquisition/address decisions now refuse a transitioning mount immediately, preserving its owner. A still-current mounted directory remains readable. Existing HTTP handlers map refusal to unavailable; retry after transition. |
| CompanyJoinClient HTTPS discovery/commands | Only 5s socket inactivity; DNS/slow trickle could exceed it | Fixed: absolute 5s budget starting before request creation; destroy owned request/response on failure; recheck owner on each data chunk. Existing TLS/pinning, size, redirect, cookie and response checks retained. |
| Company join local status/probe/reconnect | Finite sequential discovery/status/redeem/ack requests | Each RPC now bounded; a multi-step operation can exceed one 5s budget. Durable unknown-outcome bookkeeping retained; no blind replay. |
| Pilot certificate inspection; advanced pairing client | Absolute 5s TLS/request deadline | Already bounded. Leave/pairing disconnect remote wait is 2s; polling is background. |
| Directory certificate inspect / CA fetch | TLS 5s; LDAP connect/message 5s; chain depth ≤4; search server limit 3s; size ≤256KiB | Finite stages. No arbitrary AIA/referral fetch. Physical socket close remains owned. |
| Directory settings proof / prepare / test / apply | Configured TLS/LDAP message timeout 0.5–30s (default 5s) | Already bounded per network step. Sequential retained-group validation can exceed one timeout; explicit Hub administrative operation, not a Fleet-wide readiness gate. Currency is checked between steps. |
| Directory suggestions / roster helpers | Additional absolute 5s operation abort | Already bounded. Admission refuses overload (4/person, 32 total); there is no waiting admission queue. |
| Web/member address DNS / temporary listener checks | DNS 2s per selected listener; owned local listen/close | Remote DNS wait bounded. Preserve positive physical listener drain instead of racing away ownership. |
| Member relocation acknowledgments | Shared 5s deadline, parallel Fleets | Already bounded across the batch, not a sequential 5s per Fleet. |
| Certificate generation | OpenSSL timeout 10s / 64KiB output | Local, already bounded; no model/vendor request. |

## Ownership and limits

A request timeout does not establish that a remote write was not accepted. Admitted socket writes therefore settle as uncertain and existing journals/receipts decide retries. Local SQL/settings commits, physical process/socket/listener teardown and sealed recovery sequencing must retain ownership until they finish; a generic Promise.race around them would falsely claim completion. This audit bounds remote waits and prevents unrelated hot paths from joining them; it is not a claim that JavaScript timers can interrupt a blocked event loop or an arbitrary native/OS call.

The controlled latency fixture replaces vendor CLIs and adapters with synthetic MCP agents. It exercises real FleetManager boot ordering, stdio MCP children, paired TLS/WSS member states and local IPC delivery. Its readiness boundary is two agents able to list tools, not real-model response time. Numbers and exact source bindings belong in the measurement receipt, not inferred from static code.
