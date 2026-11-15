# Hub hot-path results (M-3184)

This consumes Cairn’s static-catalog #4004; no duplicate stdio/menu or disconnected-handler implementation. The audit inventory is [audit.md](audit.md).

## Measured boundary

Owned bubblewrap mount/PID/network namespace, hidden host HOME, Node v22.22.2, private fake-owner pairing, actual loopback TLS/WSS Hub and production FleetManager/HubRuntime. Vendor CLIs and chat adapters are inert. Two synthetic agents each start a real stdio MCP child and complete tools/list before the Fleet declares them ready. Delivery ends when the owned target IPC socket receives the frame; it does not claim model consumption or platform delivery.

One boot per condition; six steady tools/list samples and six ordinary IPC handoffs per condition. Boot order/cache noise means these are observations, not a claim that Hub up/down makes startup faster.

| Hub condition | Two agents tools-ready | tools/list median (max) | IPC handoff median (max) | Hub status lookups |
| --- | ---: | ---: | ---: | ---: |
| Not configured | 0.897 s | 1.939 ms (2.748) | 0.159 ms (0.735) | 0 |
| Paired, online | 0.836 s | 2.164 ms (5.147) | 0.184 ms (0.278) | 0 |
| Paired, silent handshake | 0.754 s | 1.976 ms (2.171) | 0.202 ms (1.637) | 0 |

The up case positively verifies the production member link is online. The down case positively observes an accepted-but-unanswered TLS upgrade while measuring; it is not merely a disabled feature. Both agents expose the same worker catalog: 55 definitions / 57,747 UTF-8 JSON bytes. This is schema-response size, not model token cost or a vendor deferral audit. See [timings.json](timings.json) for raw samples.

## Changes and checks

- Absolute 5s WSS send completion, settlement on end/retire, uncertain outcomes and bounded outstanding writes.
- Absolute 5s company-join HTTPS request/response budget, including pre-socket/DNS time and trickling bodies; retired owners cannot accept more chunks.
- Settings acquisitions refuse a shared mount transition instead of awaiting unrelated member work. Current mounted directory access and physical drain ownership remain.
- Native menus follow the same configured static catalog policy; disconnected calls still refuse at authoritative dispatch and read-only/profile ceilings remain.

Fail-first: socket, join and runtime tests each had 3 failures before the fixes; native visibility/refusal controls had 5. Corrected guards pass; native cases pass 35/35 and socket final 5/5.

The netless focused campaign passed 72 unchanged cases. Its sole failed case was the new online benchmark fixture: low-level pairing had not selected the profile for FleetManager. After completing only that synthetic local selection, all three measurement cases passed. No production code changed between those two runs. [network-first.log](network-first.log) retains the setup failure; [measurement.log](measurement.log) is the corrected run. Thus all 75 distinct focused cases are green across the two scoped runs; no broad healthy-suite rerun was added. Source/test typechecks pass.

Run `bash scripts/manual/hub-hotpath-audit/run.sh` for the complete netless packet, or pass specific test paths for an affected-only run.

## Risks and rollback

Slow Hub-only network operations can now return unavailable/uncertain after their finite budgets. Multi-step sign-in or directory validation can exceed one network step’s budget; they are explicit administrative operations. A timed-out write may have arrived, so existing operation journals and frozen retries remain authoritative. Ordinary same-agent queued work can still wait behind a Hub question’s existing 5s authorization gate; unrelated/human delivery is independent.

Local durable writes and physical cleanup remain serialized. No deadline claims to interrupt a blocked event loop or OS call. Revert this PR to roll back; reverting only native menu changes restores connectivity-filtered catalogs but does not change authoritative Hub permissions.
