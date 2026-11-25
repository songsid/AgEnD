# Needs you: Claude Code's usage-credits prompt (M-3757)

Real-app captures from `scripts/manual/claude-usage-credits-m3757/capture.mts` at source `0ade269f1` (no uncommitted `src/` changes; see `receipt.json`). The card is the one AgEnD reads from the live Claude Code 2.1.332 capture (`tests/fixtures/claude-2.1.332-usage-credits-consent-dialog.pane.txt`), posted through `FleetManager.postRemoteCard` as the daemon's `remote_card` would be. The rig uses the real web HTTP, sessions and DOM, a host session, and inert agents; only Lumen waits at a dialog.

There are five cases: desktop 1366×900 in English light, zh-TW dark and zh-TW light, and a 390×844 phone in English light and zh-TW dark.

| File | What it shows |
|---|---|
| `*-1-needs-card.png` | Needs you: "lumen is asking you", the prompt's words, and its own two choices, each with a plain subtitle in the UI language. **1. Switch to Opus 5.5 and continue**: "Uses your plan" / 「用方案內的額度」. **2. Continue with Fable 5.2**: "Billed to usage credits, separate from your plan" / 「另外從用量點數扣款（不在方案內）」. No Esc or Skip is offered. |
| `*-2-confirm-credits.png` | After choosing 2: "Keep Lumen on Fable 5.2?" / 「讓 Lumen 繼續用 Fable 5.2？」, with "Lumen's replies may be billed to usage credits, separate from your plan." / 「Lumen 之後的回覆可能會另外從用量點數扣款（不在方案內）。」, and the buttons **Cancel** / 「取消」 and **Continue on credits** / 「繼續（用點數）」. |

All 50 checks in `receipt.json` pass:
- each card shows both choices with their subtitles and no skip;
- the confirmation names the agent in plain words;
- no answer reaches the agent before the confirmation, after Cancel, or after the dialog's ✕, which behaves exactly like Cancel;
- the card stays;
- no horizontal overflow and no page errors.

Seen on the card, not specific to this one: the item's one-line summary is clipped with "…", as every Needs-you item is. The "❓" before the agent's name draws as a box in the rig's headless browser, which has no emoji font. The choices' own labels are Claude's English words, in either language; the subtitles say what each means.
