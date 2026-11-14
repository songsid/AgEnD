# M-3118 — agent posts and mentions

Initial product checkpoint: `bd87f2ec9f4fe40536d78415e706fac5a374735b`.
Plain alpha sync: `7cf313c42b69e8c5d4b405fe254e3f6f1e57685a` (incoming48553e76, own source unchanged).
Reviewed delta checkpoint: `b4ca46b8723e2152387150e76336278329c855d7`.

The old path reserved `agend-hub` for existing answer correlations and stored room agent answers with an empty mention
list. It had no proactive post transport, room mention resolution or agent-source room delivery provenance.

The new member-link operations use current own-publication/room membership, durable idempotency, one Hub-owned episode
and monotonic source depth. Fleet-owned receipt verification maps explicitly to the paired Hub owner. Answer return is
an encrypted, audit-bound queue with an exact acknowledgement, separate from ordinary room input/report correlations.
See the design note for the accepted quiet-reset and receipt policy.

## Validation recorded so far

- Fail-first actual Hub HTTP/SQLite/real audit:3 semantic assertion failures (missing person mention, second agent ask,
  proactive result). Those cases now pass.
- Focused invocation:13 files,195 passing, covering new parser/server/UI/protocol, retained R1/R2, source audience floors,
  source/room budgets, receipt reuse, owner-not-person membership, durable return/restart/ACK, owner search and held reads.
- Selected initialized production factory cases:2 passing (room-post capability only with its HTTP feature).
- Both final source and test TypeScript programs exit0 at b4ca46b8.
- The alpha sync changes none of this PR's own source. No local sync re-verification campaign is claimed.
- Nine isolated source reversals are assertion-caught: depth, pending quiet reset, source rate, receipt-root reuse,
  room @all policy, audit-bound return content, source Fleet, source audience and proactive notification. Each reversal
  was restored. These are runtime-transpiled Vitest controls, not nine independent native TypeScript compilations.
  [Summary](checks/source-reversals.json).
- The review delta's server/protocol/capability cases pass23 in2 files. The localized status-wrap and existing Fleet
  status cases pass28 in2 files; the ordinary Fleet default still folds. These overlap earlier scopes and are not added
  to the195 count. [Review delta](checks/review-delta.log), [status wrap](checks/status-wrap.log).

The return notification now carries the original operation identifier, so the Fleet can recover only its encrypted
frozen intent when the original post result is permanently lost. A notification never invents an RPC success or the
original post timestamp. Rate feedback coalesces by agent/window, all five outbound operations require the feature,
and acknowledged or expired return rows are pruned.

The actual HTTP/SQLite/real-audit browser walk passes17 checks in two views. Desktop en/light shows a proactive post
without a quote and a via post with agent styling; phone zh-TW/dark shows the complete depth stop wrapping beneath the
final answer. Both original images were visually inspected. The member link/answers are inert fixtures: this walk
does not claim Fleet/MCP input or vendor execution. [Browser receipt](browser/receipt.json),
[desktop](browser/desktop-en-light.png), [phone](browser/phone-zh-TW-dark.png), [visual scope](browser/visual-check.md).
Reproduce from the repository root with `PW_DIR=<existing Playwright package directory> GOMAXPROCS=2 nice -n 10
node_modules/.bin/tsx docs/evidence/hub-agent-posts-m3118/browser/walk.mts`.

The single combined journey passes1/1 on isolated integration commit `0c01c30d3338761cbf675a96baa2ab0500162ae2`
(R b4ca46b8 + C d9fd3dd1). It uses actual stdio MCP, the Fleet factory, pinned WSS, R HTTP/SQLite and real audit;
physical inputs and directory are inert. It verifies read/post tools, an absent-owner verified @all post, permanent loss
of its original result, early exact-intent answer recovery, lost ACK/reconnect without duplicate input, current admin
refusal and held-read disclosure fences. Two test assumptions were repaired during this same journey: refusal responses
carry the existing operation_id; ACK commit precedes cleanup on the next wake. No runtime repair was needed.
[Exact scope and bindings](integration/manifest.json), [result](integration/combined-after.log). The C test remains in
its own PR; this R PR retains the result rather than importing Fleet source.

Fable source-cleared the initial product and the b4ca46b8 delta, including all three P3 repairs. The later plain alpha
sync imports unrelated generic-name/comment and smoke-script changes; own source/tests are unchanged and were not
locally re-run. Still to be recorded: Lumen's image check, exact-head CI and acceptance. This is not final acceptance.

## Risks and rollback

The bounded cooldown deliberately allows a scheduled chain to continue after thirty quiet minutes and no pending
agent-to-agent ask; this can spend the answering owners' quota. The PM has deferred a daily cap/room switch to launch
planning. Agent removal and publication/pause controls remain effective.

The additive `s3-room-agent-posts` migration retains episodes, actions, receipt roots and return intent. Older binaries
refuse the newer registry. Roll back using the pre-upgrade Hub backup; do not drop this component or rewrite retained
human/direct rows. Disconnecting a Fleet withdraws these tools, and older Fleets never negotiate them.
