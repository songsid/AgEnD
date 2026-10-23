# Codex 0.163.0 → 0.164.0 audit

**Verdict: SAFE for the captured AgEnD integration surfaces; no production change.**

Native Linux x64 packages were installed with npm into private prefixes. Each version ran with a scratch HOME,
AGEND_HOME and CODEX_HOME, a private tmux socket, and a mock Responses API. The capped systemd units used
`unshare -rn` with loopback only, a minimal `env -i`, 2 GiB memory / no swap / 200% CPU. No real account, fleet,
host CLI update or live tmux pane was used. Both package binaries and companions stayed in their original layout.
Binary SHA256s and exact literal-presence checks are in `literal-presence.json`.

## Static precheck

The precheck's one unhinted hard hit is **not a new message**: `rate limit reset consume timed out` exists in both
binaries, as do all ten hinted prefixes. The adjacent `search remote plugin catalog` text is not part of that error.
The reset RPC implementation and its TUI consumer are byte-identical between the tags (`source-carry.json`).

- [Reset consumption: 10-second RPC timeout](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server/src/request_processors/account_processor/rate_limit_resets.rs#L44-L80).
  [Same implementation in 0.163.0](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/app-server/src/request_processors/account_processor/rate_limit_resets.rs#L44-L80).
- [TUI reset failure hides the RPC detail and keeps the retry/close picker](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/tui/src/chatwidget/usage.rs#L401-L427).
  This is an account-operation failure, not exhaustion of a model turn. The bare internal string triggers no AgEnD
  error/dialog/ready detector. The optional five-second credit-detail warning is also unchanged.
- `Press R to retry` / Analytics, `Resume the task to continue…`, `press R to continue here`, `Usage limit reached`,
  `rate limit exceeded; sleeping`, and `Continue with Luna Reserve` all retain their exact prefixes in both binaries.
  The precheck's longer concatenations are string-table neighbours, not evidence of new terminal messages.
  [The task-action resume instruction](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/tui/src/app/agents_overview_actions.rs)
  is distinct from the session-resume picker captured here.

## Native frames and production verdicts

`01630/` and `01640/` each contain 20 native frames. `capture-manifest.json` identifies each raw source frame and
its production predicate results. Paths become `/tmp/codex-audit`, UUIDs and clock times are normalized, and trailing
spaces are trimmed. Prompt words, glyphs and line wrapping remain unchanged. The probes use the production
`CodexBackend.writeConfig`, `preTrust` and `buildCommand`, with an empty MCP map and only the mock provider.

| Surface | Both versions / AgEnD result |
|---|---|
| Fresh composer, completed/near-limit turns | Ready and idle; no dialog. Production nudge suppression remains effective. |
| Eight-second mock response | Busy; composer remains available for queuing. |
| Usage-limit HTTP 429 and insufficient_quota | Turn's own decorated row → quota/pause. Historical warnings are excluded from the assertion. |
| Transient HTTP 429, retries exhausted | `■ exceeded retry limit, last status: 429 Too Many Requests` → rate_limit/nudge_continue, not quota. |
| Rate-model nudge, suppression removed, 80×24 | Existing rate picker → Escape only; current model retained. |
| Resume loading and resumed mock turn | Loading holds input; exact-session resume reaches idle and completes a later turn. |
| Resume into another pre-trusted scratch git directory | Working-directory selection is held, no automatic confirmation. |
| Folder trust | Human hold; no automatic key. |
| Unauthenticated fresh launch | Human hold. 0.164.0 adds **Use Amazon Bedrock**; configured mock-provider launch still reaches idle without onboarding. |
| `/permissions` and queued `/permissions` | Selection held; queued ordinary prompt is not sent until dismissal. |
| Tool approval with approval-on flags | Human hold. Escape cancels the inert `echo probe` request and restores the composer. |

The approval-on case replaces the production YOLO flag with `--sandbox read-only --ask-for-approval on-request`.
It does not claim that the approval dialog appears under the normal YOLO launch. The mock's new `approval` mode
requests escalation explicitly; other modes are unchanged.

`queue-receipts.log.txt` records both holds and releases. Each ordinary queued message produces **one** Responses
turn after Escape. A separate title-generation request also mentions its text; the manifest distinguishes that
background request from the exact user-turn input. The live queue sequence uses **Tab**, not Enter:

1. Start an eight-second `slow` turn.
2. Type `/permissions`, then Tab; type `queued audit request`, then Tab.
3. Capture while the permission picker is open; assert the mock has not received that text.
4. Set mock mode `ok`, press Escape, capture completion; count exact last-user-message requests.

This exercises the public queued-menu behaviour. It does not claim to reproduce the old sub-frame dispatch race.
[Upstream #55682](https://github.com/openai/codex/pull/55682) adds the missing pending-popup fence.
[Upstream #56033](https://github.com/openai/codex/pull/56033) enables the Bedrock onboarding choice by default.

## Reproduction and limits

Use `scripts/manual/codex-version-audit/rig.sh` with `AUDIT` set to a scratch root and HOME beneath it, and private
`codex-<version>/node_modules/.bin/codex` prefixes. Start the rig only inside `env -i … unshare -rn`; bring up lo.
Use `gen-cmd.ts` with `GEN_EXTRA_TOML` containing `request_max_retries = 0` and `stream_max_retries = 0` inside the
mock-provider section to obtain terminal 429 failures promptly. Capture `ok`, `slow`, `near`, `usage`, `e429`,
`insufficient`, resume, untrusted-folder and nudge-enabled launches. The queued-menu sequence is above. The
approval mode adds `sandbox_permissions: require_escalated` to the existing inert shell tool reply.

Authenticated Luna Reserve, usage-reset purchases/consumption, AWS credentials, remote gateways and real provider
permissions were **not** exercised. Their retained literal prefixes and the byte-identical reset implementation
are source/static evidence, not account-level acceptance. No new broad rate-limit or resume patterns were added.
No production code changes means rollback removes only the audit artifacts and optional mock mode. The leader
marks the version audited after the PR merges; this audit does not update the installed host CLI.
