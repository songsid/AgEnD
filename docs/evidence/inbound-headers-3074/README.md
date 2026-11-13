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

## Alpha parity and native scope

Alpha base `ac1e5a65905b010aa6e1419713c88f6985581749`. Shared presentation,
human binder/receipt helpers, rules, tests and skills carry main's implementation.
Conflict resolution retains alpha's Pane abstraction, broadcastFleetMessage,
Follow ledger/portable transcript parser, and native transcript exclusions. The initial alpha base lacked main's Claude model observer. A later plain sync
from alpha af6f44ae1 brings #3815; its native model-current and allowInference
fences are retained with main's genuine-boundary correction and four listener cases.

Alpha-only: an owned fresh native acquisition can use the installed grammar;
resumed/reattached native contexts require the proven legacy introduction. Native
Claude/Codex compaction events preserve the baseline, sidechain, checkpoint and
owner fences and reach the same reminder epoch through the monitor.

Fail-first: fresh/resumed/reattached capability cases3red; native Claude/Codex
context observations2red. Restored production: six focused files132/132, including
the full1728-renderer golden; native lifecycle/source30/30 after the extra event
wiring. Three additional reversals catch fresh-only capability, retaining a reset
through checkpoint and rejecting sidechains. No real Windows execution claimed.

All1728 incoming alpha golden hashes matched the old builder. Normalizing ONLY
the added header rule, the exact WEB/VERIFY receipt-rule substitutions and the
new user-header example reproduced every incoming rendered string exactly, then
the new hashes were recorded. Existing matrix/assertions/case count remain.

Ridge's main-only observer finding: ordinary distinct served-response records
reported a snapshot update, not a model change. The main replacement now compares
normalized selected/served models and owned session identity. The subsequent
alpha af6f44ae1 sync brings its observer feature; the same correction and tests
are retained, alongside alpha's native current-owner/allowInference fences.
Fixed grammar instructions and one-time transition notices are extra context
overhead; the header-byte estimate excludes them and is not net fleet billing.

Final alpha sync with af6f44ae1 preserves native modelCurrent/allowInference fences
while carrying the same genuine-boundary helper and listener controls as main.
Five focused files pass128/128 after the sync (before the additional R5 pin).
R5 adds the unknown-model launch control; main listener12/12 and its guard-removal
reversal1red/11controls pin first metadata arrival without resetting the stamp.
Ridge independently cleared the common production R2 correction.

Native TS7 source and test checks pass on the af6f44ae1 merge. Alpha listener
file including R5 passes13/13. The same8 legacy CI expectation corrections are
carried from main: exact actor tags, escaped metadata and command-reset fields,
with all existing authority/fence assertions retained. Main slice255/255.

The same8 CI contract files pass255/255 on alpha after the sync and R5 pin.

Prism receiptless-fallback P2 is fixed on alpha with the identical shared helper
and FM→daemon tests: fresh bot metadata/body escaped, owned persisted wire and
historical wire-less rendering retained, foreign handoff no exemption. Main
fail-first3red, fixed80/80, three semantic reversals caught. Alpha receipt and
formatter80/80 plus source/test nativeTS7 pass on the final helper. No authority,
ACL, proof, deadline or retry change; optional closure-cleanup P3 left scoped out.
