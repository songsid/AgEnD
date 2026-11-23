# Composer edge focus — M-3540 (main)

The actual browser hit on the composer's top/side padding is `DIV.composer`, not an editable field. Main remains focused. Double-click selects inter-element wrapper whitespace (a space/newlines), producing a selection bar without a usable text caret. The displayed placeholder is a separate non-editable span; pointer-events:none alone does not make this decorative surface unselectable. No editable mirror or hidden input caused the reproduced case.

The row now delegates primary padding presses/clicks to its actual textarea. Its decorative text/whitespace cannot be selected; textarea text explicitly remains selectable. Buttons, links, inputs, right-click and secondary pointers keep their own behavior. The existing composer/layout/tokens are reused; no dimensions, colors, permission or send changes.

`focus-control.json` records actual baseline and corrected desktop hit/focus/selection/typing probes. The mounted regression fails one real focus assertion on base (10 other cases pass), then passes. The three affected suites pass 312/312; test typecheck has zero errors; changelog assembler passes.

## Captures

All four originals are the actual app on a scratch FleetManager, synthetic roster, zh-TW/dark, desktop 1366×900 and Chromium touch-emulated phone 390×844. Each has empty and typed states. `capture.json` records the exact source and browser assertions: edge focus, typing, no document selection, textarea selection, Attach chooser, no sends, no horizontal overflow and no CSP errors. No agent/provider is started. Phone evidence is touch emulation, not a native OS keyboard/device test. Static PNGs alone do not prove focus or typing.

Desktop double-clicks cover top/left/bottom padding. Phone taps cover top/bottom; Chromium retargets the 2px gutter beside Attach to that button (actual pointer target recorded during diagnosis), which intentionally retains its file chooser. This is not claimed as a blank-padding tap. No controls are intercepted to force textarea focus.

- `desk-dark-zh-TW-empty.png`
- `desk-dark-zh-TW-typed.png`
- `phone-dark-zh-TW-empty.png`
- `phone-dark-zh-TW-typed.png`

Reproduce with `scripts/manual/smoke/smoke-composer-focus-m3540.mts` and the standard REPO/PW_DIR/CHROME/OUT fixture environment. Source and PNG hashes are in `verification.json`. The dev twin follows actual main merge; dev uses its shared ComposerInput, so its integration will preserve that component and caller boundaries.

USER LOOK HOLD: draft, no gate until explicit Leader release. Rollback reverts the padding delegate and selection CSS, with no data migration.
