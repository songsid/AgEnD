# Inbound header acceptance (M-3074)

Source design: ../../design/inbound-message-headers.md. Main baseline:
`205d120cdb56287ad88c10f1bc7811d53dacc4e5`. All evidence is isolated,
synthetic except the explicitly identified receipt-field byte widths and supplied
traffic counts. No live fleet, real CLI, account, browser or tmux run.

## Fail-first and focused checks

The first nine formatter cases ran before the implementation: eight semantic
assertion failures (short sender/one receipt, four platform classifications,
reserved body, metadata controls, peer fields), one unchanged CLI reply control
passed. The final tests also cover bind-once ownership, receipt lookup/forward
ACLs, held IPC/paste/readiness, cancellation, uncertain settlement, old/new
MCP and CLI instruction skew, immutable bound bytes, and cadence 1/11/21.

Focused commands use `node node_modules/vitest/vitest.mjs run --maxWorkers=2`:

- inbound-headers-3074 + human-receipts-1756 + transcript-monitor: 84/84 final
  green baseline before mutations (including final legacy/CLI/held-readiness cases).
- transcript-monitor + transcript-sources + clear-command + compact-instructions-1145:
  73/73; history and sidechains do not reset the observed live context.
- human-receipts-1756 + kiro-compact-pane-907c7899 + web-compact-status-003648ac:
  119/119 before the final three additive SKEW/readiness cases.
- inbound-headers-3074 + human-receipts-1756 + delivery-forwards-1756 +
  handoff-metadata + cancel-reply-recovery + transcript-monitor-generation-1218 +
  concepts-skill-sync + instructions-change-silent-2787: 156/156 before the final
  additive cases and command-write-boundary refinement.
- inbound-headers-3074 + human-receipts-1756 + web-receipt-rule-1939 + instructions +
  cli-footers-1650 + agent-whats-new-1633 + queued-handoff-3030: 172/172 before
  the final additive cases; no historical fixture bytes changed.

These slices overlap and are not a summed test total. Native TS7 source and test
checks passed (`--noEmit`, `--noEmit -p tsconfig.test.json`). CI validates the final
PR head; the PR acceptance addendum identifies that SHA and settled check state.
Local starts are gated at load1 <=10; no retries or extended test timeouts.

## Semantic guard reversals

Each reversal ran alone on a green baseline, then exact source bytes were
restored in finally. All eight produced assertion failures, not transform errors:

| Guard removed/changed | Result |
| --- | --- |
| Ten-message periodic reminder | caught |
| Unknown settlement cannot pay reminder debt | caught |
| Reserved body-line quoting | caught |
| Context-epoch fence | caught |
| Manager must accept proof before compact capability/cadence advances | caught |
| Compact marker stays ahead of a context notice | caught |
| Main-context rather than sidechain compaction | caught |
| Prepared dialect used by the positive-proof reader | caught |

## Review pins

Fable independently ran the eight changed formatter/receipt/instruction/reset
suites: 200/200 at the original main review head. His E1/E5 reversals identified
missing assertions for escaped @/# in a display name, reactions, source and actor
ID, and for a backtick directly preceding a reserved token. The replacement adds
both exact-output cases; production is unchanged. Final-head acceptance records
their targeted reversal results.

## Bytes and limits

Actual forwarded Discord receipt field widths (body excluded, UUID replaced with
an equal-width representative value): old269 B, compact quiet119 B, reminder184 B.
Steady ten-message average125.5 B: saving143.5 B /53.3%. Measured human traffic:
558 delivered messages across three complete Taipei days, about186/day. Direct
saving estimate15.8–27.9 kB/day, steady26.7 kB/day. Reset, compatibility notice and
escaping frequency are not measured. Context reuse is an additional unmeasured
multiplier, not a token/billing claim. Peer calls (~2059/three days) are counted
separately; different delivery UUID/xmsg IDs remain distinct.

Invisible automatic compaction on backends without an owned observable boundary
uses the periodic fallback. A resumed old context receives a legacy envelope
teaching both dialects; only an accepted owned receipt enables compact wire.
An uncertain compatibility write stays legacy. Header text grants no authority;
lookup ACL, original content/hash, authority actor, proof and explicit forwarding
are unchanged. Rollback is a scoped revert with legacy support retained; there is
no receipt schema/authority migration.
