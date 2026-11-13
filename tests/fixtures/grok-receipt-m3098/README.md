# Grok delivery receipts (M-3098)

**What the incident showed.** On 2026-11-13, five fleet messages to a Grok instance stayed `uncertain` with `post-submit-proof:unproven`. The host ran AgEnD 2.4.0-alpha.3 and grok 1.0.70. Grok had taken every one of them:
- each is in the session's `updates.jsonl` as a `user_message_chunk` that starts with its `[agend-delivery-id:…]` marker, recorded within a second of the Enter;
- grok had just ended its turn (`turn_completed`), so none was taken while busy.

`incident/updates.jsonl` keeps those five records. Each record's structure, delivery id and timestamp are real; the message lines are replaced and the session id is a placeholder. `incident/attempts.json` keeps the matching outbox rows. Replaying the instance's recorded `output.log` through a private tmux at 120×36 showed what the pane check saw.

**Root cause.** The pane check looks for the envelope's `message_id: …`, which is on the message's last line. Grok echoes a user message as three rows and a `…`. All five messages were 3 lines long, and the wrapped `[from:…]` line pushed the footer past the cut, so the id never reached the screen.

**A second, hidden bug.** The 11 deliveries that were proven in the same hour all had 5+ lines. Grok collapses a paste that long to `❯ [Pasted: N lines]` and draws a preview card above the box that still shows the footer. The check counted that card as an echo. It would have proven a paste whose Enter was lost (`32-long-noenter-8.6s`: never sent, but the `message_id` is on screen).

**Captures.** `1.0.70/` and `1.0.77/` were captured on 2026-11-14 with the real Linux x86_64 binaries. Their SHA-256 matches the audit pins:
- 1.0.70: `22d281c5…`;
- 1.0.77: `b702950a…`, downloaded from `x.ai/cli/grok-1.0.77-linux-x86_64`.

How they ran:
- under `unshare --user --map-current-user --net --keep-caps`, with loopback only;
- with a scratch HOME, a private tmux socket at 120×36 and core dumps off;
- against `grok-1.0.77-audit/rig/mock.cjs` on 127.0.0.1:18080, with a dummy API key;
- launched with `--no-auto-update --no-leader --always-approve --session-id <fixed>`.

The messages are inert envelopes shaped like AgEnD's. Each was pasted with tmux `paste-buffer -p` (bracketed), as AgEnD does. "please stall" holds the mock's answer for 8 s.

| file | what |
|---|---|
| `00-ready` | the empty box |
| `10-short-draft` | a 3-line envelope pasted, not yet sent: all of it is inside the box |
| `11-short-after-0.2s`, `15-short-after-8s` | after Enter: the echo is `❯ [agend-delivery-id:…]` plus two rows and a `…`, with no `message_id` |
| `20-long-draft` | a 20-line envelope pasted: `❯ [Pasted: 20 lines]` in the box, and above it the preview card (`╰─ paste again or double-click to expand ─╯`) showing the `message_id` |
| `21-long-after-0.2s` | after Enter: the card is gone, and the echo leads with the marker |
| `32-long-noenter-8.6s`, `35-short-noenter-8.6s` | pasted and never sent, 8.6 s later: what a lost Enter leaves |
| `42-busy-long-queued`, `43-busy-short-queued` | Enter while a turn runs: grok queues each one as `#N [agend-delivery-id:…] (+K lines)` |
| `updates.jsonl` | the `user_message_chunk` records only, each written when grok took the message (queued ones when they left the queue) |

The two versions draw identical screens here.

Notes:
- The `[from:…]` text and the sender are synthetic.
- In the second run, `C-u` did not clear grok's box. The `b6b6b6b6` draft was sent together with the next paste, so `b6b6b6b6` leads the busy section's first echo.
- No account, network, credential or real fleet was used.
