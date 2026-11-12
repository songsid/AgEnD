# R1: align the existing signed-in View pin

Fable found a stale expected href in `web-instance-nav-n1`: the selected signed-in `/view/docs-writer` row was still expected to link to View. The intended new action is Chat; the other-agent View links and public `viewOnly` behavior remain unchanged.

Before: exact submitted head `5130193a0`, one assertion fails /22 controls pass ([receipt](before.json), [log](before.log.gz)). The fix is one test expectation only, `/view/docs-writer` → `/ui/chat/docs-writer`; no product change or weakened public-View assertion.

After: clean test-fix head `7a6d84a51` passes36/36 across `web-instance-nav-n1` and `web-agent-back-chat-3714`, with one worker. The native TypeScript7 test check passes. [Exact command receipt](receipt.json); logs1/2 are lossless gzip.

[Git-object parity](parity.json) binds unchanged `src`, scripts, fragments and browser directory to the original submission. Prior source/type/browser/mutation scopes carry. No browser rerun, new screenshot or additional product behavior claim. The new submission needs its own exact-head CI and Fable verdict; the parent #3732 user hold remains.
