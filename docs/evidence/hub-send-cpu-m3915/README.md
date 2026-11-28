This change reduces repeated work in the Hub's existing direct-message event path. It adds no token-streaming protocol, conversation credential, authority cache or general guard frame.

## Scope and invariants

- A direct message event selects its exact timeline row through the existing `readPage` / `readCurrent` path. The same transaction, read admission, current asker, grant, room, content projection and final fences apply. A visible older message outside the latest 100 can now update; a foreign room or asker cannot.
- The message branch uses the room projection owned by that reader. Its unused preceding `rooms.view` is removed. Unread and room-change events retain their fresh views. Nothing is retained across events, viewers, sessions or rounds.
- `HubCore.revocationVersion()` calls the concrete store's `readVersion()`. That method runs the existing private checked-image path on every invocation: fresh exact SQL bytes, strict validation, independent private floor, revision equality, unique IDs and sticky refusal. It returns two primitive values; no retained graph escapes. Audit and fleet/binding readers keep their owning reads.
- The SSE queue bound, retry budget, ordering, final response and close-on-revocation behavior are unchanged. There is no blanket progress delay: the supported protocol carries a whole final answer, not individual producer tokens.

## Diagnostics

`AGEND_HUB_SEND_TIMING=1` enables fixed-label timing through the existing Hub logger. It is off by default. Labels cover submit, relay, authorization, answer and event projection, with receipt, coarse presence and directory/grant/sign/audit subphases. Metadata contains durations only, with no request text, principal, room/message ID, URL, credentials or headers. Logger and clock failures cannot affect delivery.

`durationMs` is elapsed wall time. Where Node exposes a thread CPU clock, `threadCpuIntervalMs` is CPU used by that thread during the interval. Async phases overlap and must not be added or interpreted as exclusive attribution. The matched fixture's round-level main-thread CPU is measured separately.

## Conversation-token evaluation

A signed token authenticates past facts. The directory adapter has no push membership-change feed, so an external group removal cannot immediately bump a Hub version. Grant revisions, link generations and global transport revocation versions are distinct. A minutes-long credential replacing fresh group eligibility would widen the unobserved-revocation window. This change does not implement that proposal. Existing exact-operation leases and fresh checks remain.

## Verification and measurement scope

Focused controls cover shared-page parity for questions, answers, files, buttons, generated poll results, expired content and standalone agent posts; old-message selection; foreign-room/asker refusal; live stream invalidation and existing backpressure retry; and fresh scalar-reader refusal. Baseline assertion controls distinguish selector, duplicate-proof and scalar changes from setup failures.

Measurements use synthetic identities/content, the full mounted Hub runtime and mock directory/member transport. The mock producer generates local chunks for about 20 seconds and sends the existing whole final-answer frame. The mock member samples aggregate busy/idle presence every five seconds and sends only changed states, as the real publisher does. Concurrent mock turns share a per-exposure busy count. First working/progress, first visible final reply and delay after producer completion are separate metrics. Primary completion also waits for the final idle projection. Fake-directory timings cannot establish live LDAPS/TLS/network cost. No live Hub, Fleet, directory, provider or native CLI is exercised.

The owned rig uses two pinned logical CPUs with a conservative aggregate 0.758 CPU quota, 1 GiB RAM and a 512 MiB Node heap. VM-normalized CPU uses the supplied current 1.32 factor; quota-throttled wall latencies are not multiplied again. The generator shares the quota, so its CPU is recorded separately. Capacity means only an observed tested workload, with all issued/error/censored work disclosed, not a production user guarantee. The mock producers can run concurrently on one exposure; real member-CLI queues, live directory latency and external network delays are outside this Hub-capacity measurement.

Before formal review, the PR acceptance record supplies the final matched measurements, source bindings and private report hashes. Raw reports and the finished reader-facing report remain separate from this source change. The requested target is at most 100 ms VM-normalized Hub CPU per send plus final answer, with p95 at most 250 ms; no target achievement is claimed here.

## Rollback

Revert the exact-event selection, redundant-view removal and scalar call together to restore the former full-page projection path. Disable the diagnostic flag independently. There is no schema migration, persisted credential or authority-state change.
