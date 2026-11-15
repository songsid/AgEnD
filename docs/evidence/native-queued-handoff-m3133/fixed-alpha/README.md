# Native queued hand-off acceptance on fixed alpha

Source: `afd4ac65bc01b3c692fbc1e36721978633444ea2` (merged #4013). The tracked tree was clean when built, using the manual Windows-adapter build and `source-receipt.mjs`. See [build-receipt.json](build-receipt.json). The compiled code bundle is byte-identical to repaired product `42462a18`; its already-recorded taken result is carried without another run.

This uses the original signed-in Windows Codex 0.165.0 home, a private one-agent coordinator, and a separate native host that can survive coordinator replacement. All prompt bodies are one line. Actual FleetManager/Daemon/native lifecycle, pane RPCs, provider transcript reader, queued-hand-off store, MCP reply and dashboard marks are used. Coordinator tmux/provider paths are fenced. No fake transcript, consumed callback, idle clock or receipt was supplied. The user's running Fleet, panes and settings were untouched.

| Acceptance leg | Result |
|---|---|
| User approval and clean native build | Verified; build receipt attached |
| Busy queue → taken | PASS, carried from the identical compiled repair product; [original packet](../../native-codex-launch-4012/README.md) |
| Coordinator replacement, same native launch | PASS: different coordinator PID and holder; same Codex PID, pane/launch/host and session; zero input/key RPCs by the replacement; one original applied paste, one confirm, one reply; record removed |
| Interrupted/idle, not taken | NOT ACCEPTED: no not-taken event after 130,158 ms plus a 12-second once-only check; source idle timer never started |
| Coordinator replacement, old launch gone | BLOCKED before hand-off reconciliation: resumed Codex has an empty composer but no accepted footer; startup times out |

## Same-launch proof

[Structured result](same-launch/acceptance-result.json), real [events](same-launch/events.jsonl), [RPC intents](same-launch/rpc.jsonl) and [ACKs](same-launch/acks.jsonl) pin the identity and single-paste assertions. The new holder reuses exactly the retained runtime cursor. A built-in image reviewer opened [the original chat PNG](m3133-same-launch-taken.png): it shows the real agent chat, a double delivered tick and `M4012_TAKEN_A`, with no account path, email or sign-in code. The runtime header still says working in that capture; it is not evidence of idle.

## Interrupted observation

The actual native Ctrl+C ACK was positive; the owned wait command was then released for cleanup. No other key, draft edit or input was sent. The CLI restored the unconsumed queued envelope into a multi-line composer. The live busy row was gone, but the daemon remained working with pasteQueueDepth=0 and idleForMs=null in all 50 samples. After 130,158 ms and another 12 seconds there were zero not-taken events, zero confirmations and zero canary replies. [Structured result](interrupted/acceptance-result.json) records passed=false. The runtime record remained pending with redeliveries=0.

A built-in image reviewer opened [the original final chat PNG](m3133-interrupted-still-processing.png): a single processing tick, no delivered or failed tick, no agent reply, and runtime working. No account path, email or sign-in code is visible. [The real pane text](interrupted/pane-sanitized.txt) shows the draft and Context footer. This is not a successful idle/not-taken verdict: the daemon's idle prerequisite never became true, so the 90-second not-taken timer could not run. No callback, clock or status was forced to make it pass.

## Gone-launch observation

The old launch was positively closed while the request was still queued. The next coordinator attempted the ordinary pinned-session resume, without clearing the composer or typing another prompt. Its source startup rejected before `reconcileQueuedHandoffs()`.

The read-only capture observer recorded 471 samples over 119,996 ms on the resumed launch. [The exact source detector applied offline](gone-launch/readiness-diagnosis.json) reports busy=false, no active dialog, an empty composer, no Context footer, and readiness=false. The pane contains historical setup text plus “Conversation interrupted”; it does **not** contain the queued canary. [Sanitized text](gone-launch/pane-sanitized.txt) masks owned scratch paths and account/email, and normalizes trailing blank space; its original hash is retained. This corrects an earlier inference that the gone-launch pane had restored the queued request as a draft.

[The startup error](gone-launch/startup-error.txt) is “Native Codex composer needs attention before conversation verification”. `native-pane-lifecycle.ts` waits for ready before `/status`; the currently accepted footerless-resume shape requires a passive footer. The observed empty layout has neither footer. `Daemon.startAdmitted()` reaches hand-off reconciliation only after native acquire/startup finishes, so [the old runtime record remains pending](gone-launch/pending-after-refused-start.json), with redeliveries=0, rather than producing the requested unverifiable notice. No successful gone-launch verdict is claimed. The full product's error-card/Needs-you presentation was not exercised by this start-promise harness.

## Scope and exclusions

The first interrupted attempt stopped after 15 seconds without an idle prerequisite. A second draft-helper attempt failed on an absent native-backend method before any clearing edit. Neither is a not-taken verdict. The source owner rejected driving a private delivery helper to change the acceptance precondition; no such clearing took place. The first gone-launch attempt lacked a startup-pane capture, so the single read-only diagnostic repeat supplies that missing discriminator. No identity/readiness guard was bypassed.

Frozen controller sources are in [controller-source](controller-source). They are evidence of this isolated run, not a new supported product controller. Reusing them requires fresh unique owned scopes and the original manual build prerequisites. The repair's argv controls and ordinary-message checks were not repeated here.

No product source change is included in this packet. The remaining finding requires an owner/Leader decision before another fix or acceptance rerun.

## Cleanup and remaining work

[Cleanup ledger](cleanup-ledger.json) lists all six new owned scopes, including excluded attempts. Each has a positive pane/host close, an official archive of its exact owned session UUID, zero processes matching its unique scratch tag, and a removed scratch root. The repair packet's ten earlier cleanup receipts carry separately. No test pane or browser is left open.

M-3133 steps 3/4 and 6 pass. Steps 5 and 7 stay unchecked. Fix ownership and the recovery behavior for these observed layouts need the Leader's decision; then only those affected acceptance legs should be repeated. This evidence-only branch changes no runtime behavior. Removing the packet is its complete rollback.
