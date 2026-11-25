# Needs you: Claude Code's usage-credits prompt (M-3757)

Real-app captures from `scripts/manual/claude-usage-credits-m3757/capture.mts` at source `fddd85bf2` (no uncommitted `src/` changes; see `receipt.json`). The card is the one AgEnD reads from the live Claude Code 2.1.332 capture (`tests/fixtures/claude-2.1.332-usage-credits-consent-dialog.pane.txt`), posted through `FleetManager.postRemoteCard` as the daemon's `remote_card` would be. The rig uses the real web HTTP, sessions and DOM, a host session, and inert agents; only Lumen waits at a dialog.

There are six cases: desktop 1366×900 and a 390×844 phone, each in English light, zh-TW dark and zh-TW light.

| File | What it shows |
|---|---|
| `*-1-needs-card.png` | The compact card. One-line title in the UI language: "Fable 5.2 costs extra. Switch model?" / 「Fable 5.2 要另外收費，要換模型嗎？」. The agent is named by the group header above it; the chat, which has no such header, says "Lumen: Fable 5.2 now costs extra. Switch model?". Two full-width stacked buttons of one width: **Switch to Opus 5.5 (uses your plan)** / 「換成 Opus 5.5（用方案額度）」 (primary) and **Keep Fable 5.2 (billed to credits)** / 「繼續用 Fable 5.2（另外扣點數）」. A folded "Show Claude's text" / 「看 Claude 原文」 toggle, and "Open chat" / 「開啟聊天」 as a small link. No emoji, no Esc or Skip. |
| `*-3-claude-text.png` | The toggle opened: Claude's own words (its title, body and option labels), in English as Claude shows them. |
| `*-2-confirm-credits.png` | After choosing the credits button: "Keep Lumen on Fable 5.2?" / 「讓 Lumen 繼續用 Fable 5.2？」, with "Lumen's replies may be billed to usage credits, separate from your plan." / 「Lumen 之後的回覆可能會另外從用量點數扣款（不在方案內）。」, and the buttons **Cancel** / 「取消」 and **Continue on credits** / 「繼續（用點數）」, one width on desktop and phone. |

The buttons are named by what each option does, read from Claude's own labels (never by position); other variants of the prompt ("Not now", "No, keep my current model", "Request usage credits from your admin", "Upgrade to …") get the same style.

All 108 checks in `receipt.json` pass:
- the title is in the UI language and fits one line; both buttons are stacked, one width, one line each, with the switch as the primary button;
- Claude's words are folded by default and shown by the toggle;
- no emoji or Claude body on the card, and "Open chat" is a link, not a button;
- the credits choice asks to be confirmed first, naming the agent in plain words, and the confirmation's two buttons are one width;
- no answer reaches the agent before the confirmation, after Cancel, or after the dialog's ✕, which behaves exactly like Cancel; the card stays;
- no horizontal overflow and no page errors.
