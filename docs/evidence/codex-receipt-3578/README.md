# Codex receipt confirmation latency (#3578 / M-2836)

The clean upstream confirmation ladder contains a matching latency mechanism, including in v2.3.4. It is not a diagnosis of the external reporter's unrecorded slow deliveries or of #3199.

A first post-Enter frame can still hold the paste (`stranded`). The old ladder then waits up to30s for readiness without running the submission judge; a new busy turn keeps readiness false. The caller's late proof finally sees the accepted message. The fix observes the same positive judge while that wait is pending, stopping for proof or a retired owner. Readiness still gates the single recovery Enter. A held read loses authority when observation ends.

## Evidence

- Fresh real audited Codex0.167.0 (`cdcb45aaa01d0f14e298985e09465aebccd47f64ecd298aea44814af7b62bbda`), private tmux/home, local mock Responses API, no routes/account/vendor. Raw retained frame5ms after Enter, representative submitted/busy frame117ms. Fixtures remove only trailing empty viewport rows; tests substitute only their own fresh receipt UUID.
- Real private-tmux recorded-stream replay, production judge and real readiness timers: before30022ms, only late proof; fixed330ms, direct confirmation. Both use0 recovery Enters. The busy frame is deliberately held past30s to isolate this mechanism, not to simulate the reporter's workload timings.
- Six live CLI confirmation controls on identical recorded daemon bytes: Codex0.167.0 and Claude Code2.1.319, each idle/busy/resumed, all confirm with exactly1 Enter. See `live-cli-receipt.json`. These drive production `confirmAfterEnter`/judge/readiness with manual owned tmux paste+Enter; they do not claim a full fleet/outbox live journey or model consumption. Mock API acceptance includes native queued input.
- 262/262 in11 focused/related suites, both native TypeScript checks,133 fragments. Real private SQLite tests cover receipt settlement and forwarding admission/ACLs. Three latency fail-first failures and eight pending-forward fail-first failures are listed separately. Five semantic reversals are caught, including retired in-flight reads and visibility bypasses.
- Pending rejects never grant forwarding authority. The existing delivered-only gates remain. Hidden/missing/ambiguous/uncertain/terminal references stay unavailable; mixed lists admit no partial grant; the same operation succeeds once only after positive delivery.

`source.json` binds live legs and final source hashes. `cleanup.json` is the final ownership audit:0 owned native PIDs, mocks/tmux closed and scratch homes removed. Initial capture cleanup missed10 detached managed Codex app-server processes; exact CODEX_HOME/PID-start/pidfd checks removed only those owned processes. Stable live controls use `--no-daemon` and distinct homes. Diagnostic runs also exposed a bare multiline paste (corrected to bracketed paste), early startup/prompt-only readiness and an immediate busy-seed Enter. Those are fixture setup failures, not PASS or product regression claims. A source-mutating diagnostic campaign was discarded; all six accepted legs record the same final daemon hash.

## Reproduce the bounded offline mechanism

Use a scratch HOME and an owned output path. Dependencies come from the checkout; no package installs, model CLI or external network are needed for replay:

```sh
REPO=$PWD OUT=/your/owned/replay.json MODE=after \
  unshare -Urn node --import tsx scripts/manual/codex-receipt-3578/replay.mts
```

To capture a new raw stream, provide the audited binary explicitly (`CODEX_BINARY`, same hash as above). The capture uses a local mock and explicit non-daemon CLI in a private namespace, with only loopback enabled:

```sh
CODEX_BINARY=/your/audited/codex \
  unshare -Urn python3 scripts/manual/codex-receipt-3578/capture.py /your/owned/capture "$PWD"
```

The author-only harness copies preserve exact run structure; local package paths require adjustment before use. Nothing here authorizes a live fleet/account, network/OS changes or a Windows run.

## Risk and rollback

Extra observations are bounded and single-flight during the existing30s wait. Positive proof, owner fences, retry count, sender ACL and delivered-only authorization are unchanged. Revert the two source changes to roll back; no schema/data migration. No web UI or lazy module change, so style/browser SKEW is not applicable.

## Review D6 follow-up

The post-wait owner fence is now pinned for both generation and tmux replacement **after** the predicate observes `submitted` but **before** the wait resolves. Proof is staged until the confirmation result is consumed, matching the production verdict/receipt sequence. Both cases return false, leave the receipt queued and send no Enter. Removing the existing post-wait `current()` check fails exactly these two tests; restored suite10/10 and test types pass. Production bytes and all recorded live/replay evidence are unchanged; prior262-test clearance carries.
