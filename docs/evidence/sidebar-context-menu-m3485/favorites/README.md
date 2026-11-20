# Favorite and Split in the sidebar context menu

The PR acceptance lines were added before implementation. Favorite reuses the existing sidebar item callback, disabled/limit state, `nav.favorites` preference and local cache; it closes the context before the row moves into Favorites. The existing row controls remain intact. Context-only zh-TW copy is 「加到我的最愛」 / 「從我的最愛移除」; the existing row control's copy is unchanged.

Split already calls the workspace controller with the selected Agent's name. Its desktop behavior was left unchanged. The phone sheet exposes it only if that existing workspace capability is offered; no phone workspace support was enabled. The current narrow-phone fixture has no Split capability, so it shows Favorite but no Split.

## Fresh real-app originals

| Requested view | Original |
|---|---|
| Desktop dark zh-TW · right-click | [Open](desk-dark-zh-TW-sidebar.png) |
| Desktop light EN · right-click | [Open](desk-light-en-sidebar.png) |
| Phone dark zh-TW · long-press | [Open](phone-dark-zh-TW-sidebar.png) |
| Extra: desktop Favorite enabled / remove label | [Open](desk-light-en-favorite-on.png) |

All four originals were inspected for readable labels, target identity, shared component styling, clipping and synthetic-only content. Exact zh-TW remove wording is exercised by the mounted locale test; it is not claimed to appear in these images.

The same owned scratch app and three plain Example agents were used. Desktop 1366×900, touch-emulated phone390×844, Chromium headless. No UI replacement or provider/lifecycle/real-account calls. The recorded [three-case checks](checks.json) keep existing action parity after excluding the requested sidebar additions; opening does not navigate, Escape restores the row, and no CSP/page error, overflow, clipped popup or unexpected write occurs.

The desktop EN case adds Beta through the new menu, observes the same cached favorite list, opens the existing row menu with its remove state and removes Beta there. It then selects Split from Beta's context menu while Alpha is current; the real workspace renders **Example Alpha and Example Beta**. The phone retains its existing capability boundary. A capture assertion initially assumed phone Split support and was corrected to check the actual existing capability; this did not change production availability.

## Focused proof

- Properly initialized signed-in preference fixture, original submitted source: four assertion failures (mouse/keyboard/touch Favorite and offered phone Split), one positive existing desktop Split. The additional zh-TW case also fails on the original source.
- Six focused suites:62/62; final new test file with locale case:6/6 (five overlap). Existing instance-nav suite:23/23. Test type-check exit0.
- Mounted actual components exercise both favorite directions/cache, no menu reopening after the row moves, existing control presence, exact bilingual labels, and target Beta versus current Alpha through mouse/touch. The existing shared favorite setter and workspace controller are used, not copied storage or split implementations.
- Original source/gesture/card/command clearances carry outside this requested delta. No broad or native/provider campaign repeated. This is not physical-phone/Safari acceptance.

The PR stays draft under the user's visual hold. One commit carries the requested addition and fresh evidence. Rollback remains UI/skill only; saved favorites use the existing preference format, with no migration.
