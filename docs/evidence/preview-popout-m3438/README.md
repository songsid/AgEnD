# HTML preview window (M-3438, dev)

Main #4265 contains only the every-width full-screen fix. This dev change carries that fix and adds the new preview window using the existing chat pop-out transport. Both PRs remain on the user visual HOLD.

## Behavior and boundaries

The new button opens a separately authenticated chat route in preview presentation. Only a bounded message/fence or attachment locator crosses the exact-origin/window/session/nonce handshake. The child reads its own authorized history and attachment; HTML, credentials, sender identity and consent are not transferred. The original preview closes only after the matching acknowledgement, with its chat draft retained. Blocked windows, timeout or a changed source retain the original.

The child keeps the existing chat store, stream and PreviewPanel mounted, so Versions, Changes and Pages work. Reply about page and source controls return to its ordinary chat without sending. Full screen operates on the panel, never the HTML iframe; the existing immersive fallback remains available. The iframe sandbox, CSP, preview port and public-link policies are unchanged. The private module is optional and is not loaded by the Hub.

## Proof

- Initial preview transport tests fail before the implementation (three cases), then pass alongside the existing chat transport; missing HTTP cryptographic nonce fallback also fails before its fix.
- Related offline run: 247 tests across 12 files, covering the transport, panel widths/versions/pages, reply-file controls, frame/CSP/Hub boundaries and module inventory.
- Additional attachment boundary case passes: own registered HTML only, same-origin loader, missing/over-50-MB refusals, no inherited launch consent.
- Startup reversal (incorrectly requiring visibility before waiting for the child status/host) fails the late-readiness test; restored implementation passes.
- Three shared stylesheet suites: 47 passed. Source and test type checks pass.
- Final real-app headless Chromium: desktop EN/light at 760×800 popup and phone zh-TW/dark at 390×844, with synthetic messages only. Both handoffs retain the source draft, render the child's own page, expose Versions/Changes/Pages, enter immersive full screen and return to the child composer. No sends, page errors or outer horizontal overflow. Phone launch target is 44×44; Changes' existing inner horizontal region remains scrollable. Sandbox is exactly allow-scripts and the preview origin differs from the dashboard.
- Final six originals independently inspected: desktop source, popup, Changes, Pages, full screen, plus phone source. Earlier phone popup/Changes/Pages/full-screen originals were inspected; final phone Changes scroll position also has automated bounds checks. No concrete visual or private-data finding.

## User review samples

- [Desktop pop-out](captures/desk-light-en-popout.png) · [Changes](captures/desk-light-en-changes.png) · [Pages](captures/desk-light-en-pages.png) · [full screen](captures/desk-light-en-fullscreen.png)
- [Phone pop-out](captures/phone-dark-zh-TW-popout.png) · [Changes](captures/phone-dark-zh-TW-changes.png) · [Pages](captures/phone-dark-zh-TW-pages.png) · [full screen](captures/phone-dark-zh-TW-fullscreen.png)

## Limits and rollback

This is a scratch fixture/browser and stubbed test proof, not a live account, provider CLI/model, Fleet launch, native Windows or Safari campaign. Popup full screen used the immersive fallback; the separate main evidence covers the native fullscreen API and refusal fallback. Shared-browser popup behavior can vary by browser policy. User visual approval, designated exact-head review and green CI are required; both actual post-merge CI results remain task acceptance. Revert the change to remove the controls and optional presentation route; there is no migration or stored-data change.

## Current visual correction

The original captures above are historical. See [R1 toolbar correction](r1/README.md) and its retaken captures for the current user look. Secondary phone controls now use the shared options dialog; fullscreen is a standard icon button.
