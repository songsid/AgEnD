# Dev integration (M-3557)

Standalone alpha base `e6c36b782b9a39687991b75e2606755e9ebda50c`, prepared after actual main merge `0f0128f6f6ebaf14e3d86dfcf6900efd106623b3`. Fetched main ancestry and all nine approved main blobs were verified before creating this twin. This PR shares the fix-only beta.19 freeze exception; unrelated held work remains frozen.

The helper is byte-identical to approved main. The dev drawing uses shared ComposerInput/WorkBarView and Fleet's workspace/native/phone-meta variants. Add only exact-target background markers to those existing surfaces. Removing the markers and restoring the explanatory task-row comment reconstructs both complete original dev production components byte for byte. No actions, feature gates, CSS, pane IDs, native-runtime behavior or Hub mention logic change.

The original main README/result/verification packet, main browser harness and changelog fragments are retained byte-identically. They remain historical main proof, not a fresh dev execution claim.

## Fresh dev proof

Implementation `081fdc3bc59650a08ff67ec6051885e57d879758`, followed only by these integration evidence files:

- Composer and task-reference mounted suites34/34 PASS, including the carried exact popup/unknown-descendant regression and existing work-bar/phone/native control cases. Test typecheck exit0; changelog772 fragments PASS.
- Actual dev Chromium desktop mouse and phone mouse/emulated touch choose slash `/sysinfo` and task `#M-1` from the real app's role-option lists. The fixture creates one synthetic board card and performs no send. Edge-background focus/typing and an unknown popup's own mousedown still work, no CSP violations.
- Hub `@` audit: its list is a sibling of shared ComposerInput, outside the Fleet strip listener; only its input's actual background opts in. One mounted real RoomComposer test places its role-option list inside an even stricter hypothetical marked strip, proves pointerdown remains unprevented and mousedown selects the mention. This is component evidence, not a native-Hub browser run. An initial test setup reset imported two Preact module instances and failed before mounting; that setup was corrected before the recorded pass.
- Model menus, task and command palettes and unknown content do not carry the background marker. Exact-target eligibility never propagates to them. Existing native-control guards remain an additional exclusion, not the mechanism relied on for popup protection.

[Fresh browser result](dev-browser-result.json) and [nine source bindings, preservation checks and private-log hashes](dev-verification.json). No screenshots or new visual layout are claimed. No native-device/WebKit/provider/live-pane campaign. Run the copied main regression harness for slash/edge behavior, and `scripts/manual/smoke/smoke-composer-popup-dev-m3557.mts` for the additional real task-reference list. The mounted Hub test is `tests/web-composer-popup-mention-m3557.test.ts`.

Rollback the helper and its background markers together in a normal follow-up, preserving other dev features. No runtime/configuration/database rollback is needed.
