# M-3118 — agent posts and mentions

Source checkpoint: `bd87f2ec9f4fe40536d78415e706fac5a374735b`.
Plain alpha sync: `7cf313c42b69e8c5d4b405fe254e3f6f1e57685a` (incoming48553e76, own source unchanged).

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
- Source and test TypeScript programs exit0. Logs remain private under `.artifacts/3118/`.
- The alpha sync changes none of this PR's own source. No local sync re-verification campaign is claimed.

Still to be recorded here: one compiling-control packet, the two-view localized feedback walk, C's actual MCP-to-server
composition, ordinary Fable review, exact-head CI and acceptance. This is a preparation checkpoint, not final acceptance.

## Risks and rollback

The bounded cooldown deliberately allows a scheduled chain to continue after thirty quiet minutes and no pending
agent-to-agent ask; this can spend the answering owners' quota. The PM has deferred a daily cap/room switch to launch
planning. Agent removal and publication/pause controls remain effective.

The additive `s3-room-agent-posts` migration retains episodes, actions, receipt roots and return intent. Older binaries
refuse the newer registry. Roll back using the pre-upgrade Hub backup; do not drop this component or rewrite retained
human/direct rows. Disconnecting a Fleet withdraws these tools, and older Fleets never negotiate them.
