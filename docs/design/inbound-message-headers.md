# Compact inbound headers (M-3074)

Status: design proposal; no formatter or instruction changes yet. Source baseline:
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
[user:hanhanv@discord#368442276000694273] 請看這個問題
(message_id: 1570789578372157571)
(Answer with the reply tool; terminal text does not reach them.)
```

After, ordinary message:

```text
[hid:hmsg-00000000-0000-4000-8000-000000000000]
[user:hanhanv@discord#368442276000694273] 請看這個問題
(message_id: 1570789578372157571)
```

`hid` is a display key, not a new identifier or API argument. Pass its unchanged
`hmsg-…` value to `delivery_status {message_id, detail:true}` and `forwards`.
The platform `message_id` remains for reactions and reply addressing. Do not
substitute it for the human receipt ID.

Telegram uses `[user:name@telegram#account-id]`. Web preserves its classification,
for example `[user:name@web (verified)#account-id]` or `[user:name@web (guest)]`;
omit the `#…` only when the existing trusted metadata has no user ID. A label is
never authority: the complete receipt's actor/proof/origin remains decisive.

Alternative for the user's choice: keep the full sender on its first message or
when the sender changes, then use `[user:hanhanv]`. This saves another 27 bytes
in the Discord example, but relies on remembered identity and exact delivery order.
It makes identical display names and forgotten context harder to interpret. Prefer
the stable short key set above.

Peer `[from:Display Name (instance-name)]` remains readable and unchanged.
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
the pure formatter. Select an immutable presentation stamp once, before hashing
the exact wire. Snapshot and actual delivery must render the same bytes. Multiple
formatting calls and retries must not increment the count. Reserve concurrent
human admissions in order, with explicit cancellation and ownership fences.

A queued message prepared before a context reset is an important integration
case: the next actual write must still get its reminder, while no previously
bound receipt hash is silently changed. The implementation must stamp at the
last owned preparation boundary (or explicitly rebind only a still-unwritten
queued receipt) and test this race. Never reinterpret already-delivered bytes.

Legacy prepared messages and historical fixtures keep their original bytes.
Marker recognition accepts both the old `[agend-human-id:…]` and new `[hid:…]`,
using the known receipt metadata to choose proof; it never scans body text to
invent a trusted ID. New markers stay before steering and what's-new notices.
No receipt database identity, authority column, ACL or forwards semantics changes.

## Security finding and proposed handling

Current rendering concatenates display fields and body text directly; brackets
are not a cryptographic or textual trust boundary. Existing protection is the
server-owned origin, exact prepared-wire hash, owned delivery proof, and row ACL.
The existing forged-header negative checks that body text cannot create a human
origin. Preserve and extend those checks; do not call current typography
unforgeable.

To keep user text from creating additional apparent top-level headers, escape
reserved envelope-looking lines in untrusted bodies (human and peer) as quoted
content, and escape line breaks/control characters and delimiters in label fields.
Cover forged hid/user/from/delivery/metadata lines and reply-to text. The original
content and its hash remain unchanged in the receipt; only the deterministic wire
presentation is escaped and separately hashed. The normal message's body is
unchanged. Raw mode remains explicitly outside positive human-proof guarantees.
No textual marker, even a copied genuine one, grants authority or forwarded ACL.

## Compaction observability: decision needed before implementation

AgEnD currently follows explicit compaction through Claude/Codex structured
records and Kiro's owned pane, but does not observe every automatic compaction on
every backend (`src/compact-watch.ts:2–24`). A ten-message cadence does not prove
that the first message after an invisible automatic compaction gets a reminder.

Proposed bounded first slice: reset on every command/launch/model/session/context
reset AgEnD observes, including explicit clear/compact before another message can
be admitted; reuse owned Claude/Codex compaction records and Kiro outcomes. Keep
the ten-message fallback for otherwise invisible automatic compaction. This
limitation needs the leader's decision; do not advertise universal first-message
coverage without additional per-backend observations/fixtures. The alternative is
a separately scoped compaction-observation audit across all backends.

## Byte measurement and daily estimate

Measured from the forwarded real Discord receipt's actual username, account-ID,
platform-message-ID and hmsg lengths; its body is excluded and not saved here.
The repeated human ID is 41 characters. These are UTF-8 byte counts, not tokenizer
counts. The artifact stores counts only, no user message content.

| Case | Header/footer bytes | Saving against current |
| --- | ---: | ---: |
| Current envelope | 269 | — |
| Proposed with reminder | 189 | 80 (29.7%) |
| Proposed without reminder | 124 | 145 (53.9%) |
| Steady ten-message average | 130.5 | 138.5 (51.5%) |

Savings = `80 × human_messages + 65 × omitted_reminders`, less any escaping
expansion. Short sessions/resets give fewer omissions. With one long context:
1,000 human messages/day saves 138.5 kB/day; 10,000 saves 1.385 MB/day. These are
explicit scenarios, not a claim that tool-call counts equal inbound human traffic.
An exact fleet-wide per-day figure needs the real daily human admission count and
reset/reminder frequency. Peer envelopes above have no assumed savings.

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
