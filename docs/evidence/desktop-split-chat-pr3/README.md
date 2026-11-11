# Desktop split chat — PR3

Refs #3637, M-2924 / S-123. This slice adds native sidebar/header docking, a shared physical sash and an in-page floating pane. The real browser pop-out remains PR4. The owner round follows PR4, as requested.

The existing router, leave guards, pane leases, composers and page stream remain the owners. Sidebar docking extends its existing reorder handler; foreign drags and attachment drops are not adopted. Edge previews occupy exactly half the target; an existing agent dropped in the center swaps positions, while a third agent replaces the target through the same leave guards. Escape, a changed navigation incarnation, changed bounds, a dialog, lost capture or teardown cancels pending geometry.

The sash uses one 8px layout slot and the shared geometry calculation for pointer and keyboard operation: 16px steps, Shift 64px, Home/End at physical minimums, Enter/double-click 50:50. The ratio remains bounded to 0–1; physical 360px/320px minimums avoid an extra percentage floor on ultra-wide displays. The float starts at 560×460, remains at least 420×360 and stays within the chat area. Its menu scrolls within the pane, including at coarse-pointer sizes. Moving DOM topology stops the old preview before entry, exit or reorder; ordinary geometry does not remount either composer.

## Browser evidence

Final source/capture pin: `6658a946`; the subsequent test-only spy isolation changes no capture input. **14 clean runs / 108 checkpoints / 108 PNGs** verify against Git: 448 input bindings, 1,986 served assets and 87 retained substitutions. Both 1600×1000 ordinary single-pane comparisons have **zero changed pixels**.

`browser/current-{light,dark,en,coarse}` contains the real app shell served by an owned scratch FleetManager, actual cookie sign-in and SSE, and Chromium. Terminal/step reads are recorded inert fixture responses. There is no Fleet start, CLI, send, Settings Apply, real account, AD or pilot operation.

Each journey measures native sidebar and header drag, the half-area preview, sash pointer/keyboard/reset/cancel, the 360px and ultra-wide minimum, stack, free float move/resize, keyboard cancel/apply, menu reachability, reload, edge re-dock, center swap, narrow fallback and phone. The original two composer nodes and the attachment belonging only to A are asserted through every arrangement before reload. Reload intentionally starts a new document and does not persist attachments. Each document records one active/max EventSource; the fixture has one SSE client at every checkpoint.

`browser/before-{light,dark}` uses exact PR2 assets from `834fb036` on the same owned server/fixture. These are controlled retained-asset baselines, not executions of an older server binary. The verifier compares their ordinary single-pane screenshots byte by byte with the current screenshots; it also checks every input, served asset and substitution against its recorded Git object. No dirty or failed diagnostic images are presented as acceptance.

`browser/skew-*` retains actual PR2 CSS, CSS plus boot, navigation, model, host, sidebar, and the inventoried JS graph; another control removes only the server display mark. An old model or missing capability keeps the original chat. An old host keeps PR2's grid with new CSS and refuses a float restore. New geometry needs the CSS flag and an explicit host/adapter opt-in; old callers of the model cannot parse float. The JS inventory is the receipt's `inputs`, not every application module: for example, chat-tour remains current. The server-mark control is a response substitution, not a second old server.

Every receipt preserves its original clean HEAD/tree and input/harness/served-byte digests. Adding this evidence does not relabel executions. The alpha sync was a conflict-free plain merge of `6b66b767`; all 12 incoming files are disjoint from this slice and retained exactly.

## Tests and reversals

Commands, outputs and source bindings are in `checks/`. The related suite covers the workspace, pane forms/operations/suspension, ordinary navigation and sidebar ordering, CSP, tokens, CSS/i18n ratchets, existing ESM skew, web preview, Hub module isolation and the incoming Office change. Both source and test typechecks and changelog assembly are required.

Final controls: **290/290 tests across 26 files**, both typechecks and **388 changelog fragments** pass. The existing preview-layout case clears its spy before measuring layout/focus/history because first split and final collapse now deliberately retire the preview too; its order and no-focus-retirement assertions remain. Text log copies trim trailing whitespace only; original and retained digests are recorded.

`scripts/manual/mutation/desktop-chat-docking-3637.py` performs 17 offline JavaScript reversals, checks syntax, runs the relevant production-hook tests and restores every exact source image in `finally`. Each is assertion-caught: pane minimums, float bounds, outside drops, distinct-agent docking, preview retirement, leave guards, navigation incarnation, boundary currency, pointer ownership, Escape, stable native drop targets, real DOMRect getters, browser modifiers, composer DOM identity, sidebar docking and both retained-float boundaries. Restoration is followed by the focused controls.

Fail-first logs include the browser menu overflow, native overlay replacement, ultra-wide percentage floor, retained-host float and first-split preview retirement. Early development diagnostics remain private; logs identify their scope rather than claiming later candidate execution.

## Scope and rollback

The new controls reuse the existing Menu and InstanceSwitch text tabs; the geometry follows the preview/sidebar resize pattern and uses CSSOM under the existing CSP. No write endpoint, authority, Settings key or backend behavior changes. The public asset addition is a pure geometry helper.

Browser interaction evidence is Chromium with mouse and keyboard. Coarse-pointer media checks include 44px geometry targets; native touch drag, Safari/Firefox and OS window gestures are not claimed. Preview stop ordering is pinned through the real router callback; the fixture does not execute a live HTML preview. Static PNG review proves only visible geometry, not interactions. Pop-out behavior and the consolidated owner gallery remain PR4 work.

Reverting this PR returns PR2's layout. Old code refuses the new float topology and falls back to ordinary chat; drafts remain in the existing agent store. A retained mixed graph that cannot load the optional modules keeps the original chat rather than mounting an incomplete workspace.
