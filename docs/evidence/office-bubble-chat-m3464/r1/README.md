# Separate map, area controls and dialogue

The user requested both existing overlaps fixed before the same PR ships. The dialogue now has a separate canvas row below the map. Phone area controls have their own row between them. The map fits the space it actually has; dialogue no longer paints over its bottom edge. Both rows remain available in fullscreen.

The dock mounts only for an active conversation and releases its space when that conversation expires. Paused speakers, read-only shares and reduced motion keep their existing behavior. The dock is also keyboard reachable with Enter/Space; held Enter does not open repeated windows. The existing popup, guest/session/visibility guards, draft isolation and floating-bubble hit logic are unchanged.

A versioned stylesheet is registered in the existing static asset map and loaded by Office, so the module does not depend on a cached app.css acquiring new rules. No authentication or CSP policy changes.

## Current originals

The ten PNGs are headless real-app originals with a synthetic roster:

- Desktop EN and phone zh-TW office: map and message occupy separate rows; phone area chips cannot cover the text.
- Bubble and chat: the same approved floating click/touch → authenticated child behavior, retaining Office.
- Keyboard: the existing agent-card action.
- Desktop fullscreen: both map and dock remain visible.
- Phone short landscape: the outer panel is scrolled to the dialogue. The map keeps at least 200px height rather than being squeezed into a tiny strip; its upper part is reachable by scrolling back. Decorative portraits are omitted in a short dock instead of being clipped. Portrait phone views keep them.

All ten files were covered by image inspection across the initial R1 and final short-window correction. No private names, chat IDs or live account data are present.

## Proof

- New outside-map regression: fails on the previous head.
- New public stylesheet HTTP check: fails before asset registration; passes after.
- Layout/style/asset guards: 71 passing tests in 7 files.
- Existing map, fullscreen, pop-out and module suites: 221 passing tests in 6 files; the additional HTTP case passes separately (293 distinct tests across these runs).
- Final dialogue/expiry/keyboard and CSS ratchet check: 41 pass, overlapping the totals above. Test TypeScript exits 0.
- Actual desktop and phone browser checks: disjoint map/zone/dialogue rectangles, right child chat, keyboard path, effective 44px touch target, no send, no horizontal overflow or page errors. Fullscreen and short-landscape scroll reachability pass.

The paused-speaker test now checks the first typed character and speaker selection, rather than requiring three characters at an arbitrary animation instant. Reduced-motion full-text behavior is pinned separately. No product deadline, retry or typing speed was increased.

Initial checks exposed the dock mount/reduced-motion repaint, frame callback state and missing stylesheet registration; those were fixed before final capture. The removed phone-height override had lower specificity than the base selector and no computed effect; deleting it changes no captured layout.

## Limits and rollback

This is synthetic scratch-host proof, not a provider, live account, OS-window-manager or real chat-send campaign. Short windows use vertical panel scrolling; this is not a claim that every map and dialogue detail fits into one landscape viewport.

Rollback is a revert of the presentation/assets/tests. No stored-data, account, CLI, protocol or configuration migration is involved. Visual release remains pending on these revised views.
