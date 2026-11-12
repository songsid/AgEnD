# Delivered-only target scheduling guard

Head fe489fa9810ef4fa33ebbf65ff6e4b7c7ad7c2da changes only20lines in tests/hub-pairing-notices.test.ts. Production bytes equal2e7b3f781. The real in-memory SQLite fixture retains120delivered targets; a tick must perform0flushFleet calls and at most1idle sweep current check. Removing only the scheduling query state filter fails the intended assertion with120unexpected flushes. Exact source restored; four related files pass22/22, native test typecheck passes. Existing queued-target delivery controls remain. No runtime/capacity/native/live claim.

The first invocation used unsupported --minWorkers and executed no test. It is retained separately and is NOT mutation evidence. Valid runs use --maxWorkers=1. MERGE HOLD remains until fixed-source50-code+3-group overlap passes.
