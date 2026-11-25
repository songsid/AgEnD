# Needs you: Claude Code's usage-credits prompt (M-3757)

Real-app captures from `scripts/manual/claude-usage-credits-m3757/capture.mts` at source `e97174d86` (no uncommitted `src/` changes; see `receipt.json`). The card is the one AgEnD reads from the live Claude Code 2.1.332 capture (`tests/fixtures/claude-2.1.332-usage-credits-consent-dialog.pane.txt`), posted through `FleetManager.postRemoteCard` as the daemon's `remote_card` would be. The rig uses the real web HTTP, sessions and DOM, a host session, and inert agents. Desktop 1366×900 and phone 390×844, in English (light) and zh-TW (dark).

| File | What it shows |
|---|---|
| `*-1-needs-card.png` | Needs you: "lumen is asking you", the prompt's words, and its own two choices, **1. Switch to Opus 5.5 and continue** and **2. Continue with Fable 5.2**. No Esc or Skip is offered. |
| `*-2-confirm-credits.png` | After choosing 2: "Spend usage credits?" / 「要使用用量點數嗎？」, saying only that the choice may bill this agent's turns to usage credits. **Cancel** / 「取消」 or the choice itself. |

All 32 checks in `receipt.json` pass:
- each card shows both choices and no skip;
- the credits choice asks for confirmation;
- no answer reaches the agent before the confirmation, nor after Cancel;
- the card stays after Cancel;
- no horizontal overflow and no page errors.

Seen on the card, not specific to this one: the item's one-line summary is clipped with "…", as every Needs-you item is. The "❓" before the agent's name draws as a box in the rig's headless browser, which has no emoji font. The option labels are Claude's own English words, in either language.
