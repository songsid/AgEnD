# M-3842: disabled buttons stay readable (real app)

These captures come from the #4497 capture check, which found disabled buttons nearly unreadable in dark mode. Those buttons were drawn at `opacity: 0.45`.

The shared `.btn:disabled` (`src/ui/shared/app.css`) now draws an off button this way:

- **Readable text.** The text is `--text-3` mixed 75% into `--bg`. It reaches at least 3:1 on the page and on a card, in light and dark and in every palette.
- **No fill.** It has no accent or danger fill and a dashed edge. A ghost button keeps no edge.
- **Never faded.** Opacity is no longer used to show a disabled button.
- **Send.** The chat's round Send is a quiet filled circle (`--surface-2`) with a `--text-3` icon.
- **Reply and poll buttons.** An agent's reply and poll buttons use the same off look, with no opacity on top. The chosen answer keeps its solid green edge, and a closed poll's choices keep their tallies in `--text-2`.

The rule is in `docs/design/ui-style-guide.md`, §4, under Disabled controls. `tests/disabled-contrast-m3842.test.ts` checks the rule's shape and the contrast in every theme block.

All captures are from the real web app (`scripts/manual/smoke-fixture`) in headless Chromium.

| Frames | What they show | Script, commit |
|---|---|---|
| `m3842-*-chat-send.png` (desk light en, desk dark zh-TW, phone light en, phone dark zh-TW) | An empty chat composer, whose Send is off. | `scripts/manual/disabled-contrast-m3842/capture.mts` at `d96a50095`, 16/16 (`receipt-chat.json`) |
| `m3842-*-chat-replies.png` (the same four variants) | An agent's reply buttons once answered (the chosen one solid green with ✓, the other off), once expired (both off), and a closed poll whose choices show their tallies in `--text-2`. No opacity on any of them (#4576 review). | the same run |
| `m3842-*-contact-card.png` (the same four variants) | Needs you's contact card before this browser is verified. Its decision buttons are off. | #4497's `request-contact-card-s228/capture.mts` at `9d6bb81e8`, 174/174 |
| `m3842-desk-light-en-update-restarting.png`, `m3842-phone-dark-zh-TW-update-restarting.png` | Install as a service, while AgEnD restarts. **Installing…** and the card's other buttons are off. | #4564's `update-service-button-s246/capture.mts` at `9d6bb81e8`, 57/57 |

The card and update frames were taken at `9d6bb81e8`. The later commits touch only `.btn-send` and the chat's reply and poll buttons, which don't appear in those frames. `receipt-pages.json` lists their commits and each PNG's sha256.

For comparison, the old look is in `docs/evidence/request-contact-card-s228/s228-desk-dark-zh-TW-1-needs-unverified.png` (#4497). There, the disabled Continue is a faded grey pill.
