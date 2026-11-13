# Compact inbound headers (M-3074)

Status: implementation in progress after leader choice and Prism/Ridge design
reviews. Source baseline:
main `205d120cdb56287ad88c10f1bc7811d53dacc4e5`. Main then alpha; all agent backends
and MCP / agent-CLI modes. Receipt and acknowledgement payload changes are out of scope.

## Exact presentation

The recommended sender form is self-contained on every message. It keeps the
platform account ID for Discord mentions and distinguishing equal display names;
it needs no remembered sender alias after compaction or reordering.

Before (representative IDs; body unchanged):

```text
[agend-human-id:hmsg-00000000-0000-4000-8000-000000000000]
[user:hanhanv via discord, id:368442276000694273] 請看這個問題
(message_id: 1570789578372157571 | verification_id: hmsg-00000000-0000-4000-8000-000000000000)
(Answer with the reply tool; terminal text does not reach them.)
```

After, first message / reminder:

```text
[hid:hmsg-00000000-0000-4000-8000-000000000000]
[user:hanhanv@dc#368442276000694273] 請看這個問題
(message_id: 1570789578372157571)
(Answer with the reply tool; terminal text does not reach them.)
```

After, ordinary message:

```text
[hid:hmsg-00000000-0000-4000-8000-000000000000]
[user:hanhanv@dc#368442276000694273] 請看這個問題
(message_id: 1570789578372157571)
```

`hid` is a display key, not a new identifier or API argument. Pass its unchanged
`hmsg-…` value to `delivery_status {message_id, detail:true}` and `forwards`.
The platform `message_id` remains for reactions and reply addressing. Do not
substitute it for the human receipt ID.

Telegram uses `[user:name@tg#account-id]`. Web preserves its classification,
for example `[user:name@web:v#account-id]` or `[user:name@web:g]`;
omit the `#…` only when the existing trusted metadata has no user ID. A label is
never authority: the complete receipt's actor/proof/origin remains decisive.

Alternative for the user's choice: keep the full sender on its first message or
when the sender changes, then use `[user:hanhanv]`. This saves another 22 bytes
in the Discord example, but relies on remembered identity and exact delivery order.
It makes identical display names and forgotten context harder to interpret. Prefer
the stable short key set above.

Peer `[from:Display Name (instance-name)]` remains readable; an exactly identical display/instance name is shown once.
The leading delivery UUID and footer `xmsg-…` are different IDs, not duplicates;
retain both. Remove only a second presentation of the same receipt ID. Keep reply
obligations, correlations and explicit forwarded references.

## Reminder policy and wire identity

The first human message has a reminder; subsequent periodic reminders are at
ordinals 11, 21, … (a ten-message interval between reminder positions). Launch/restart,
clear/new session, successful model/backend switch and observed compaction reset
the context epoch, so the next human message carries it. Failed/declined switches
must not reset it. Peer/system/schedule messages and raw-paste traffic do not
advance the human counter. Existing missed-reply recovery remains independent.
A reset may intentionally create reminders closer than ten messages apart.

The state belongs to one daemon launch/context epoch, never a global backend or
the pure formatter. Move new receipt presentation preparation and its existing
**bind-once** operation to the final owned write preparation, after the relevant
queue/write lock and wake/readiness waits, immediately before paste. A registered
manager-owned binder validates the receipt/admission and current launch owner;
it is not a capability inferred from body text. The final sanitizer runs before
binding the exact wire. Snapshot and actual delivery use that same frozen wire.

Do not rebind a receipt: `queued` is not proof that nothing was written. If an
existing row has a bound owner/hash, retain its dialect and exact prepared bytes;
an uncertain/potentially-written row never acquires a new wire. Legacy rows keep
the old always-present reminder. The new boundary must fail closed if the manager
or write owner changes, rather than replaying or inventing a binding.

Choose the stamp under the common write ownership fence, with one ordinal per
human receipt. Formatting calls, retries, steer and ordinary queue paths cannot
increment it twice. Cancellation before the write does not consume the first
reminder. If its write/receipt result is uncertain, leave the first-reminder debt
outstanding so another human message may repeat the hint. A context reset while
waiting in IPC/paste/readiness queues affects the stamp chosen at the final
boundary. Test held IPC, held paste/readiness, reset, cancel and uncertain races;
no modification of already-bound bytes is permitted. This moves an existing
security-sensitive binding boundary and requires implementation co-review.

Legacy prepared messages and historical fixtures keep their original bytes.
Marker recognition accepts both the old `[agend-human-id:…]` and new `[hid:…]`,
with the dialect chosen from trusted prepared metadata, not an arbitrary body
match. Every proof reader consumes that dialect; mixed old/new components fail
closed without a false delivered verdict or duplicate submission. It never scans
body text to invent a trusted ID. New markers stay before steering and what's-new notices.
No receipt database identity, authority column, ACL or forwards semantics changes.

Instruction/formatter SKEW is a separate compatibility gate. Do not infer a
consumer's dialect capability from text resembling a marker. Install instructions
that explain both formats at a proven launch/context instruction epoch before
using compact wire. A resumed context first receives a compatibility notice inside its legacy
envelope, including its old always-present hint. Only a positive owned receipt
for that write enables compact headers on later human messages. An uncertain
notice leaves the producer legacy. A fresh launch with newly installed
instructions can use compact wire immediately. This one-time legacy transition
retains the duplicate human-ID presentation so old instructions remain valid;
subsequent compact messages carry it once. MCP and agent-CLI modes use the same
transition.
Tests cover old instructions + new producer and new instructions + old prepared
bytes without losing reply addressing, receipt proof or forwarded authority.

## Security finding and proposed handling

Current rendering concatenates display fields and body text directly; brackets
are not a cryptographic or textual trust boundary. Existing protection is the
server-owned origin, exact prepared-wire hash, owned delivery proof, and row ACL.
The existing forged-header negative checks that body text cannot create a human
origin. Preserve and extend those checks; do not call current typography
unforgeable.

Escaping is deterministic and shared by human and peer formatters:

1. Display fields (name, source, peer display/instance label) and metadata values
   use visible backslash escapes for backslash, `@`, `#`, brackets, parentheses,
   pipe, CR/LF/tab, C0/C1 controls/ANSI ESC, Unicode line separators U+2028/U+2029,
   and bidi formatting controls (U+061C, U+200E/F, U+202A–E, U+2066–9). Ordinary
   Unicode names remain readable. Include reply-to, reactions, from_display,
   task_summary, branch, working_directory, attachments and all footer/correlation
   presentation values. Escape exactly once from original metadata; raw IDs and
   tool arguments remain unchanged. No value may add a physical envelope line.
2. Body/reply-to/reaction text is data: escape terminal/line-separator/bidi
   controls visibly and prefix a data quote before any line that, after leading
   whitespace, could resemble an AgEnD routing or metadata line. The reserved set
   includes old/new human markers, delivery markers, user/from/system/steering
   headers and message-id/verification/forwards/reply-required metadata footers.
   Do not infer trust from a quoted line, even one carrying a real copied ID.
3. Apply the existing final wire sanitizer, then freeze/hash those actual bytes.
   Tests include odd backtick fences and sanitizer-adjacent forged lines so that
   a later normalization cannot turn quoted data into a header.

The original content and its hash remain exact in the receipt; only the wire
presentation is escaped and separately hashed. An ordinary message body is
unchanged. Raw mode remains outside positive human-proof guarantees. No textual
marker grants authority or forwarded ACL. Include malicious reply-to, reactions,
peer metadata and labels, not only a forged header in the main body.

## Compaction observability: approved bounded coverage

AgEnD currently follows explicit compaction through Claude/Codex structured
records and Kiro's owned pane, but does not observe every automatic compaction on
every backend (`src/compact-watch.ts:2–24`). A ten-message cadence does not prove
that the first message after an invisible automatic compaction gets a reminder.

Proposed bounded first slice: reset on every command/launch/model/session/context
reset AgEnD observes, including explicit clear/compact after its owned command write and before the next queued write; reuse owned Claude/Codex compaction records and Kiro outcomes. Keep
the ten-message fallback for otherwise invisible automatic compaction. Consume
each observed boundary once under its owned launch/session/transcript checkpoint;
history replay, sidechains and another launch must not reset this counter. The leader accepted this bounded coverage and the stable sender form with dc/tg.
Do not advertise universal first-message coverage without additional per-backend
observations/fixtures. An all-backend automatic-compaction audit is outside this
implementation.

## Byte measurement and daily estimate

Measured from the forwarded real Discord receipt's actual username, account-ID,
platform-message-ID and hmsg lengths; its body is excluded and not saved here.
The repeated human ID is 41 characters. These are UTF-8 byte counts, not tokenizer
counts. The artifact stores counts only, no user message content.

| Case | Header/footer bytes | Saving against current |
| --- | ---: | ---: |
| Current envelope | 269 | — |
| Proposed with reminder | 184 | 85 (31.6%) |
| Proposed without reminder | 119 | 150 (55.8%) |
| Steady ten-message average | 125.5 | 143.5 (53.3%) |

Savings = `85 × human_messages + 65 × omitted_reminders`, less any escaping
expansion. The measured fleet traffic is **558 delivered human messages over
2026-11-10–12 (Asia/Taipei), about 186/day**; the leader received 269 (48%).
The earlier seven-day window contained 1,001 messages. Tool calls are not human
message counts.

At 186/day, the labelled direct-wire estimate is **15.8–27.9 kB/day** (every
message has a hint through no hints); the steady ten-message policy estimates
**26.7 kB/day**. Resets, short sessions, one-time compatibility notices and escaping
reduce this saving. These are byte estimates from one real Discord envelope,
not measured fleet tokenizer or billing totals; other sender/platform lengths vary.

Context persistence multiplies the effect: a header remains in context and is
read on subsequent model turns until compaction. If its average reuse is R,
context bytes avoided are approximately direct saving × R. Illustrative R=10
means 158–279 kB/day; R=50 means 0.79–1.40 MB/day. R is not measured here; cache
behaviour and tokenizer differences prevent treating this as a billing estimate.

Peer traffic is more frequent (about 2,059 send_to_instance calls over three
days, roughly 686 calls/day, not necessarily delivered messages). Its delivery
UUID and xmsg receipt are different identifiers, so this change retains both.
Only a genuinely duplicate display/receipt value is eligible for deduplication;
the duplicate peer name or identical footer ID is removed only on equality. No second-round tool-output reduction is included.

## Implementation and verification inventory

- Shared human formatter: `src/human-delivery-receipts.ts:281`; metadata footer:
  `src/cross-instance-envelope.ts:9`; peer formatter: same file, line 66.
- Receipt snapshot / hash binding: `src/fleet-manager.ts:5240–5264`;
  `src/daemon.ts:7734–7777`. Stamping cannot mutate during rendering.
- Leading-marker recognition/proof: human steer envelope, agent-whats-new,
  daemon submission signatures/composer checks, queued handoffs and delivery
  reconciliation. Preserve old recorded-stream fixtures byte-for-byte.
- Missed-reply recovery: daemon reply recovery code remains independent.
- Update together: MCP core/Message Format and web/peer verification rules,
  agent-CLI instructions, MCP delivery_status description; concepts,
  cross-instance-messaging, worker-collaboration and multi-channel skills;
  matching delivery-verification, cross-instance and web docs.
- Alpha's `tests/agent-instructions.test.ts` owns the golden renderer matrix;
  re-record only intentional wording changes and compare normalized output to the
  old matrix. Main has no equivalent golden matrix.
- Fail-first: exact compact/legacy wire, human ID once, sender collision/mentions,
  MCP/CLI hints at 1/11/21, every reset, concurrent admissions, retry/no-double-
  count, queued-before-reset, uncertain delivery, recovery unchanged; forged
  content/labels/quoted metadata and unreadable/unforwarded receipt negatives.
- All backends share the formatter; test routing/receipt owners in portable and
  alpha native Runtime paths. Focused runs only, maxWorkers=2/load gate.
- Prism security/parity review plus Ridge co-review. Main before alpha. Rollback:
  ordinary scoped revert, legacy marker support retained, no authority migration.
