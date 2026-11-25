# Needs you: Claude Code's usage-credits prompt (M-3757)

Real-app captures from `scripts/manual/claude-usage-credits-m3757/capture.mts` at source `8c8cbdcde` (no uncommitted `src/` changes; see `receipt.json`). The card is the one AgEnD reads from the live Claude Code 2.1.332 capture (`tests/fixtures/claude-2.1.332-usage-credits-consent-dialog.pane.txt`), posted through `FleetManager.postRemoteCard` as the daemon's `remote_card` would be. The rig uses the real web HTTP, sessions and DOM, a host session, and inert agents; only Lumen waits at a dialog.

There are six cases: desktop 1366×900 and a 390×844 phone, each in English light, zh-TW dark and zh-TW light.

The card uses the standard Needs-you item layout (`.n-item`, `.n-title`, `.n-detail`, `.n-actions`), as CLI prompts, contact tickets and proposals do.

| File | What it shows |
|---|---|
| `*-1-needs-card.png` | Under the Lumen group: the title "Fable 5.2 costs extra. Switch model?" / 「Fable 5.2 要另外收費，要換模型嗎？」, one `.n-detail` sentence on the bill, "Opus 5.5 uses your plan; keeping Fable 5.2 bills usage credits." / 「Opus 5.5 用方案額度；繼續用 Fable 5.2 會另外扣點數。」, a folded "Show Claude's text" / 「看 Claude 原文」 right under it, then content-width small buttons: **Switch to Opus 5.5** / 「換成 Opus 5.5」 (primary), **Keep Fable 5.2** / 「繼續用 Fable 5.2」 (secondary) and **Open chat** / 「開啟聊天」 (ghost). No emoji, no Esc or Skip. |
| `*-3-claude-text.png` | The fold opened: Claude's own words (title, body and option labels), in English as Claude shows them. |
| `*-2-confirm-credits.png` | After choosing Keep: "Keep Lumen on Fable 5.2?" / 「讓 Lumen 繼續用 Fable 5.2？」, with "Lumen's replies may be billed to usage credits, separate from your plan." / 「Lumen 之後的回覆可能會另外從用量點數扣款（不在方案內）。」, and the buttons **Cancel** / 「取消」 and **Continue on credits** / 「繼續（用點數）」, one width, the text balanced. |
| `*-4-chat.png` | The same prompt in the agent's chat, titled with the agent's name ("Lumen: Fable 5.2 now costs extra. Switch model?" / 「Lumen：Fable 5.2 要另外收費，要換模型嗎？」), with the same sentence, fold and buttons; the title is balanced, so a phone leaves no lone word. |

The buttons are named by what each option does, read from Claude's own labels (never by position). Other variants of the prompt get short buttons in the same row: "Keep current model" (primary), "Not now" (secondary), "Ask admin for credits" and "Upgrade plan" (ghost).

All 186 checks in `receipt.json` pass:
- the title is in the UI language on one line; one `.n-detail` sentence carries the bill, wrapping only at spaces and punctuation with no stub last line; the order is title, detail, fold (tight under the detail), actions;
- the buttons are `.btn.btn-sm`, content width, primary / secondary / ghost; no custom compact-card classes are left;
- on a phone, the fold and every button are 44 px tap targets and no two controls overlap, in Needs you and the chat;
- Claude's words are folded by default and shown by the toggle; no emoji or Claude body on the card;
- the credits choice asks to be confirmed first, naming the agent; its two buttons are one width and its text leaves no stub line;
- no answer reaches the agent before the confirmation, after Cancel, or after the dialog's ✕, which behaves exactly like Cancel; the card stays;
- no horizontal overflow and no page errors.
