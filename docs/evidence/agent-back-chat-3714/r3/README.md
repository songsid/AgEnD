# R3: Settings return lives in content

The owner rejected two meanings for the pane-header X. **Back to chat / 回到聊天** now sits at the top right of Settings content and scrolls with it. The phone category list has its return inside the scrolling list too. The pane-header X always means **Close this pane / 收起此格**. Header modules are byte-identical to stacked parent #3732 ([parity](header-parity.json)); Settings no longer passes back-to-chat metadata into them.

The return reuses `PageHead`, `Icon`, Settings row/touch sizing and real links. In split mode its normal click uses that pane’s existing guarded navigation; modifier clicks remain the browser’s. A single page/pop-out uses the existing router. Cancel retains staged changes. No new confirmation, write, authority, endpoint or pairing path. Sidebar re-click/Enter and the other-agent/public-View rules are unchanged.

## Current validation

All final captures and checks use clean source `ab86d1eafe8436eed90a0cec081116ad8b63af67`; packaging adds evidence only.

- [Fail-first](offline/fail-first.json):11 assertion failures/8 controls on the approved header-return implementation, with the preimplementation19-case test snapshot. The final test also adds the phone category-list control.
- [Final checks](offline/final/receipt.json):146/146 across8 focused suites with one worker, native TypeScript7 source/test checks and changelog validation. The common-header shape test is restored to the same controls on all four tabs.
- [Five selected compiling reversals](offline/mutations/receipt.json) are assertion-caught and exactly restored: return moved to the header, header X navigating instead of closing, wrong target agent, swallowed modifier click and lost category-list return. An earlier exploratory global-router substitution survived ([receipt](offline/exploration/receipt.json)); it is not counted as caught. The final wrong-target control pins the observable peer/owner outcome.
- [Browser verifier](browser-verification.json):**13 serial Chromium runs /102 checkpoints /40 PNGs**,247 Git inputs,2,653 served bindings and5 exact retained substitutions. One SSE, zero browser errors/external requests/settings writes. Source, harness and served hashes reconstruct against Git. All fresh phone returns and the retained-CSS phone returns are44×44.
- Actual browser controls cover native Enter, second-click routing, Cancel/discard, content placement/right alignment, physical scrolling where the form overflows, unfocused-pane return preserving its peer draft, and Settings header X closing only that pane. [Sixteen current Settings originals independently inspected](visual-review.md): no visual blocker.

The server/cookie/SSE/UI are real in an owned scratch fixture; status/names/config are recorded fixture data. No Fleet or agent start, message send, Apply, account, vendor CLI, AD, pilot or live-fleet operation. The existing read-only status-emoji preview is recorded separately.

## Owner gallery

| Settings surface | zh-TW light | zh-TW dark | EN light | EN dark |
|---|---|---|---|---|
| Single page | [PNG](browser/after-desktop-light-zh-TW/light-zh-TW-settings.png) | [PNG](browser/after-desktop-dark-zh-TW/dark-zh-TW-settings.png) | [PNG](browser/after-desktop-light-en/light-en-settings.png) | [PNG](browser/after-desktop-dark-en/dark-en-settings.png) |
| Split pane | [PNG](browser/after-desktop-light-zh-TW/light-zh-TW-split-settings.png) | [PNG](browser/after-desktop-dark-zh-TW/dark-zh-TW-split-settings.png) | [PNG](browser/after-desktop-light-en/light-en-split-settings.png) | [PNG](browser/after-desktop-dark-en/dark-en-split-settings.png) |
| Phone section | [PNG](browser/after-phone-light-zh-TW/light-zh-TW-settings.png) | [PNG](browser/after-phone-dark-zh-TW/dark-zh-TW-settings.png) | [PNG](browser/after-phone-light-en/light-en-settings.png) | [PNG](browser/after-phone-dark-en/dark-en-settings.png) |
| Phone category list | [PNG](browser/after-phone-light-zh-TW/light-zh-TW-settings-index.png) | [PNG](browser/after-phone-dark-zh-TW/dark-zh-TW-settings-index.png) | [PNG](browser/after-phone-light-en/light-en-settings-index.png) | [PNG](browser/after-phone-dark-en/dark-en-settings-index.png) |

The earlier R0–R2 gallery is historical before evidence for the superseded header-return design; its receipts/PNGs are unchanged. It is not the current owner gallery.

## Retained assets and limits

Five bounded controls retain exact approved R2 assets: desktop/phone CSS, Details, workspace and phone category helper. Old CSS can frame/align the return differently, but shared Settings row sizing keeps its phone target44×44. New Settings sends no return metadata, so the retained workspace header also closes the pane. Retained Details keeps its prior single-page header control; in a new split header it cannot add that return, and the selected sidebar still returns to Chat. A retained category helper omits the new phone-index child, with the selected sidebar as its existing return path. No error or unintended effect is accepted.

These are individual retained-asset controls on the current fixture server, not an old backend/whole-release matrix. Actual popup rendering is mounted-test scope; no new real browser-window/native/alternate-browser journey is claimed. Preliminary diagnostics are excluded; final thirteen captures all use the same committed, MIME-correct harness with bounded stylesheet readiness before teardown.

Review checklist: existing guarded navigation, exact owner/target and peer controls (3/5/9); actual inert paths and reversals (11); clean Git-bound current evidence and bounded SKEW/visual claims (12). No new effect, deadline, queue, recovery, dialog grammar or authorization mechanism. New scoped layout uses shared components/tokens, no inline styles or extra card frame.

HOLD: parent #3732 must receive owner OK and merge; then plain merge-sync and fresh Fable/exact-head CI checks are required. R3 also awaits the owner’s new screenshot OK. Coordinator owns merge. Rollback is an ordinary UI revert; no data migration or state rollback.
