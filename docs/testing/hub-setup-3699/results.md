# Recorded results (2026-11-12, isolated fixtures)

Base: alpha `6b66b767ba1f401ebe5d92e458c73ec22d2a1fa7`.
Node 22 dependencies; Vitest 4.1.12. Source hashes are in `source-hashes.json`.

| Check | Result |
| --- | --- |
| New real Linux self-connection with old classification | FAIL: false instead of true; genuine listener control passed |
| Original company case under bounded CPU pressure | FAIL: 10,000 ms timeout, reported 10.10 s tests |
| Fixed company case, same pressure | PASS, unchanged 10 s test budget; reported 12.90 s **including beforeEach**, 16.20 s with beforeAll |
| Full company file, serial | 20/20 PASS |
| Full compose file, serial | 113/113 PASS, including original material-change refusals |
| Original assertion inventory | All 515 compose + 131 company expect calls preserved; six added |
| Native test typecheck | PASS |
| Diff/changelog checks | PASS; no fragment for test-only changes |

The pressure pair uses the same local image
`sha256:18a6d90fd60542269850c80ca03b29b1d9b14d6b221ac7ee8e35b0d33ef904bd`,
one busy loop sharing a 0.2-CPU quota, 768 MiB memory, no network, one worker,
and one selected test. The baseline's cold import took 61.90 s; fixed 60.60 s.
These imports are outside the assertion budget in both versions. Fixed setup is
also outside that budget. One initial runner attempt stopped during import
because the launcher directory was not mounted; the runner was corrected before
this recorded baseline/fixed pair. It is not counted as the fail-first.

Four compiling semantic reversals were each applied alone and restored:

| Reversal | Caught by |
| --- | --- |
| Every TCP connect means listener present (old behavior) | Forced real self-connection: expected true, got false |
| Every TCP connect means refusal | Genuine listener: expected false, got true |
| Rig deletes caller's shared source certificates | Source certificate existence assertion after owned rig close |
| Remove shared certificate hostname guard | Exact early-refusal error assertion; later production certificate validation is insufficient |

The original file under pressure also acts as the setup-in-body reversal. No
retry, sleep, fake product result, production change or timeout increase was used.
All container work was serial, not a broad shard/stress campaign. After the
comparison, no `agend-hub-3699-*` container remained. Every test rig closes its
owned Hub/LDAPS sockets and deletes its mutable home; shared source certificates
are removed by the owning afterAll.

The original CI socket tuple is unavailable. The probe defect is proven; the
historical CI event is consistent with it but cannot be attributed conclusively.
This is test-harness repair, not evidence of a shipped Hub publication defect.
