# Office: say why drag and pat are off with reduced motion (M-3547)

These are captures of the real dashboard from this branch, taken headless with Chromium on the smoke fixture: six made-up agents, fake runtimes, no live provider, CLI or Fleet. The whole fleet's own office is shown from defaults. Reduced motion is the browser's `prefers-reduced-motion: reduce`, emulated per case.

**What changed.** With reduced motion on, drag, pat and feed have been off since M-3293, and the only sign was the greyed 「拖曳與摸頭」 box with a tooltip. The Office now says so without hovering. This is a hint only: nothing turns play on while reduced motion is on.

- **The box:** a note right after its label, inside it: "· Off while reduced motion is on" / 「· 開啟「減少動態效果」時關閉」. It stays beside the box when the bar wraps, and a screen reader reads it with the box's name. The locked label is greyed. On a phone, this is in the ⋯ sheet.
- **A person's card:** "Drag, pat and feed are off: this device asks for reduced motion." / 「拖曳、摸頭與餵點心已關閉：這台裝置開啟了「減少動態效果」。」. It's where Pat and Feed would be, above Find in office and Chat. The quoted setting name never breaks across lines.
- **Nothing is said** when play is off for another reason: the viewer turned Drag and pat off themselves, a style without zones, All offices, the carousel, Edit layout, a share link, or a Hub room's office.
- **Without reduced motion nothing changes:** no note, the box is on, and the card has Pat and Feed.

| Case | Options | Card |
|---|---|---|
| Desk, light, en, reduced motion | `desk-light-en-reduced-1-options.png` | `desk-light-en-reduced-2-card.png` |
| Desk, dark, zh-TW, reduced motion | `desk-dark-zh-TW-reduced-1-options.png` | `desk-dark-zh-TW-reduced-2-card.png` |
| Phone, dark, zh-TW, reduced motion (⋯ sheet) | `phone-dark-zh-TW-reduced-1-options.png` | `phone-dark-zh-TW-reduced-2-card.png` |
| Phone, light, en, reduced motion (⋯ sheet) | `phone-light-en-reduced-1-options.png` | `phone-light-en-reduced-2-card.png` |
| Desk, light, en, ordinary motion (unchanged) | `desk-light-en-1-options.png` | `desk-light-en-2-card.png` |
| Phone, dark, zh-TW, ordinary motion (unchanged) | `phone-dark-zh-TW-1-options.png` | `phone-dark-zh-TW-2-card.png` |

`scripts/manual/smoke/smoke-office-reduced-motion-m3547.mts` checks each case; its output is `result.json`:

- the box is off and locked, and the note is on the box's own row;
- the card's note says why, sits inside the card, and Pat and Feed are absent;
- with ordinary motion there's no note, and Pat and Feed are present;
- the page never scrolls sideways, and there are no page errors.

The note uses the dashboard's muted text colour. Its contrast is 7.0:1 on the dark card surface, 8.4:1 on the dark page, and 6.6:1 and 6.0:1 on light.
