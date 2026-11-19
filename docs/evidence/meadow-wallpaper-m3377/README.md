# Meadow wallpaper — HOLD

**User approval is required before merge.** This dev-only follow-up gives Meadow a
soft sage gradient and a small original leaf/grass motif. The paths were authored
for this change; no external wallpaper, logo or image asset is used. The tiny SVG
is inline, with group opacity bounded to 2% in Light and 3.5% in Dark. It contains
only paths; no scripts, referenced images, animation or filters.

The stationary chat panel paints the two background layers. Messages scroll in
its existing child. There is no viewport-fixed attachment, scroll handler or
animation. Explicit per-agent chat backgrounds and shell page themes retain precedence. All tokens outside
Meadow remain byte-identical to the base; only one Meadow-scoped CSS rule is added.

Names keep their opaque surface strips and bubbles stay opaque. Tests check text,
metadata and links at both gradient endpoints, with maximum tile opacity applied.
Names and bubbles remain AA, and dark metadata meets the existing APCA Lc 60 floor.
Increasing the Light motif to 3.5% turns the contrast control red; restoring 2%
passes. The first five wallpaper controls fail on the untouched base.

The focused four files pass 26 tests; a skill/contrast stage adds two distinct
controls, for 28 distinct checks across five files. Test TypeScript passes. A real
headless Linux browser run passes 22 checks with no page errors, including SVG
load, fixed panel origin during child scrolling, no horizontal overflow and an
actual CSSOM agent-background override. That is a structural scroll check, not a
frame-rate benchmark. No live account or agent backend is started.

Four originals are visually inspected: [desktop light](desk-light-chat.png),
[desktop dark](desk-dark-chat.png), [phone light](phone-light-chat.png) and
[phone dark](phone-dark-chat.png). The pattern is faint but discernible in Light,
clearer in Dark, with no clipping or privacy issue. Only synthetic content is used.
The earlier flat Meadow originals remain in the [base packet](../builtin-colours-m3368/README.md).

Reproduce using `scripts/manual/smoke/smoke-meadow-wallpaper-m3377.mts` with owned
REPO/OUT, Linux CHROME and PW_DIR. It runs serially and closes its owned resources.

R1 preserves the font-origin restriction while allowing only inline SVG images in
the token sheet; the font-face still names only the bundled same-origin font.
The original origin assertion first fails, then the affected tests pass. All
Meadow chat treatments now yield under an agent page theme, including the earlier
flat base. Two selector controls and the actual `applyPageTheme` browser control
first fail; after the fix, the page's own background, text and secondary text are
shown with no wallpaper. Clearing it restores Meadow. The focused R1 stage is
37/37 (47 distinct controls across six files in total), TypeScript passes, and the
single desktop-light browser follow-up passes eight checks. The four ordinary
wallpaper originals are unchanged and were not replaced; this boundary fix adds
no new user-facing capture campaign. User HOLD remains in force.

Rollback is a presentation revert. No migration, storage, permission or API change.
