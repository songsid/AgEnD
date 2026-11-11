# M-2872 / #3620 evidence (#3621 main, #3622 alpha)

This evidence is never merged. It sits on branch `evidence/m2872-quote-edge`, whose parent is #3621's head `4cfc571c707d319492dd6de6274d19d78bf532e7`.

**Source**
- Main: `scripts/manual/smoke/smoke-chat-quote-2789.mts` at 4cfc571c, run from the #3621 worktree.
- Alpha: the same script at #3622's head `fadc45c1f6e7065951170e9cdacc9a79aa1e211a`, which differs only by `QUOTE_REF=7dd2b0d07`.

The command was:

    PW_DIR=<playwright-core> REPO=$PWD OUT=<dir> GATE=full FONTCONFIG_FILE=/etc/fonts/fonts.conf npx tsx scripts/manual/smoke/smoke-chat-quote-2789.mts

**Receipts**
- `main/result.json` and `alpha/result.json`: 90 checks PASS, 0 FAIL, `gate: full`. The run log's "92 checks" counts result keys, including the measurements `flipRoom` and `beforeOverlapsEdgeMenu`.
- `main/run.log` and `alpha/run.log`: the script's own last line, without the punycode deprecation warning.
- `flipRoom`: `room` 8 px below the selected line inside the scroller, `need` 56 px (the pill's height plus its gap), so the pill goes above.
- `beforeOverlapsEdgeMenu.overlaps: true`: the SKEW leg serving main's previous `chat-quote.js` (QUOTE_REF d98863926). There the pill is above the line and intersects the simulated Edge menu.

**Pictures.** "Edge menu (sim.)" is a stand-in box drawn where Edge puts its selection mini menu: 132×34, just above the selection's end, centred on it. It is not Edge's own UI.
- `1-before-after-flip-en-light.png`: three crops. The previous `chat-quote.js` (SKEW leg); after (desk-light-en, passage 1); after with no room below (the flip leg).
- `2-after-zh-TW-dark.png`: crops of desk-dark-zh-TW, passages 1 and 2.
- `3-desk-light-zh-TW-full.png`: a full screen.
- `4-phone-unchanged-zh-TW.png`: phone-dark-zh-TW, passage 1, docked above the composer as before.
- `main/*.png`: the uncropped smoke frames the crops come from, plus the SKEW legs (`skew-old-panel`, `skew-old-css`, `skew-old-quote`, and `skew-old-quote-before-with-edge-menu`).
