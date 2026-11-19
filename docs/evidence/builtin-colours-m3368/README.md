# Built-in browser colours

The shared theme selector adds **Other…** / **其他…**. Its centred dialog offers
Default, Clear Sky / 晴空, Meadow / 青草, Night Violet / 夜紫 and Mint / 薄荷.
Each palette works in System, Light and Dark. Appearance and palette are separate:
changing appearance keeps the colours; Default restores the neutral palette.

This extends `AgendTheme` and the existing semantic tokens, rather than introducing
another theme engine. Settings → Look and the shared Hub/Fleet reader control use
the same dialog. The palette is a browser preference; the existing signed-in mode
preference keeps its usual storage and sync. Agent page themes and owner CSS retain
their existing precedence. No server data, identity or permission changes are made.

The radio cards preview the page immediately. Apply persists the palette and mode;
Cancel, Escape, or closing the dialog restores the prior choice. An outside mode
change retires the preview and restores its original palette before applying that
new mode, so a cancelled preview cannot leave an uncommitted palette behind.

## Validation

- Five controls fail on the untouched development base. They pin the missing
  pre-paint palette, preview transaction and the fourth menu choice in both languages.
- Nine affected theme, preference, Look and installed-chrome suites pass 153 tests.
  Five style, localization, source-scan and skill suites pass another 32 tests.
  Later asset-graph/shell and Settings checks, plus two interaction controls, bring
  the staged total to 260 distinct passing tests across 19 files. Repeated runs
  are not added again. Source and test TypeScript both pass.
- A strengthened interruption assertion first fails once, with four unselected
  tests excluded. After the fix, the three affected controller/prefs/chrome suites
  pass 44 tests; these repeat existing controls and are not added to the 185 count.
- All eight palette/appearance pairs pass `checkTheme`, the complete AA token
  matrix (text 4.5:1; focus and strong borders 3:1), metadata on accent-tinted
  surfaces, and the dark secondary-text APCA Lc 60 floor from the phone audit.
  Text sizes and layout tokens are unchanged.

A rapid palette/appearance control also fails before its fix and passes after it.
The latest draft is kept synchronously so rapid radio changes and Apply preserve
both choices. The shared asset serving gap is pinned by a separate red control.

The selected packet has 31 after views and four before views. Visual review covers
the selected layouts, all eight palette chats, the agent override, and the new
Look row. Representative chats include an enabled unsent draft and an inert
fixture warning status. No Send action starts an agent. Menu images wait for finite
CSS transitions before recording colours; a partial mid-transition image is excluded.
The scoped Look UI gate passes 14 checks; the Hub CI UI gate passes 92, with no tap
allowance changes. [Validation stages](validation.json) retain the exact scopes.

The browser harness is `scripts/manual/smoke/smoke-builtin-themes-m3368.mts`.
Supply an owned `REPO`, `OUT`, Linux `CHROME`, `PW_DIR` and Traditional Chinese
`CJK_FONT`; `STAGE=before|after` selects the assertions. `SURFACE=hub` or
`DEVICE=phone` limits a follow-up to that scope. It runs serial headless Chromium,
owned listeners, real shipped UI, and synthetic content, with no live accounts or
agent backends. The Fleet quick selector is the existing anonymous View reader's;
signed-in Fleet users also reach the same picker in Settings → Look.

## Rollback

Revert the presentation change. There is no migration or host preference key.
An older build ignores the browser's palette key and uses its neutral tokens.
