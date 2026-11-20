# Every-width preview fullscreen (M-3438 main fix)

The HTML and Markdown preview toolbar used only-wide on its fullscreen button, hiding the control below 900px even though the existing fullscreen controller already supports native fullscreen and an immersive fallback.

This main fix removes that visibility restriction and gives the narrow-screen button the shared 44px touch target. The preview frame, CSP, separate preview origin, public-link availability and fullscreen generation/cleanup behavior are unchanged. The new preview pop-out feature belongs to the separate dev-only PR.

## Validation

- Two mounted HTML/Markdown tests fail first because the button has only-wide; both pass after removing it.
- Preview widths and panel suites: 32 passed across two files, including existing native, immersive and stale-request coverage.
- Related stylesheet suites: 25 passed across three files.
- Existing real-app headless preview smoke: all five cases pass (fresh phone, desktop native, phone native, unavailable API and rejected API). The updated phone expectation requires the reachable control, enter/exit and a 44px button, not its previous absence. The added control naturally wraps the phone toolbar to three unclipped rows.
- The HTML runs only in the scratch fixture's real preview listener. The fullscreen element is the parent panel, never the sandboxed frame. No CSP/page errors or outer horizontal overflow. Selected Phone/Tablet emulation retains its existing intentional inner scrolling behavior.
- Four originals inspected: desktop native, phone native, phone toolbar, desktop refusal fallback. No concrete layout/privacy defect found.

## Captures

- [Desktop full screen](desk-light-en-3-full-screen.png)
- [Phone full screen](phone-dark-zh-TW-2-full-screen.png)
- [Phone toolbar](phone-dark-zh-TW-1-two-row-bar.png)
- [Fullscreen refusal fallback](desk-dark-en-refused-1-immersive.png)

No live account, CLI, model, Fleet startup or Windows campaign. All labels/content are synthetic. USER VISUAL HOLD remains; joint main/dev captures will be sent before review. Revert this small presentation fix to roll back; no data change.
