# #3714 / M-2960: return to an agent’s chat

A click on another agent keeps Settings, View or Log. A second click on that now-selected row opens its Chat, without a timed double-click. Native Enter follows the same real anchor. Agent Settings also has a rightmost **Back to chat / 回到聊天** X. In split mode that X returns its own pane to Chat; Chat’s X still closes the pane. Existing unsaved-change guards can cancel either navigation.

Stacked parent: #3732 at `8ac895063b4309b83b5d847e529c585a244b6d80`. The parent is held for the user’s screenshot OK. This card’s own source delta is four UI files; no CSS, server, endpoint, persisted state or authority change. It must sync by merge after the parent lands; the coordinator owns merge.

## Checks

- [Preimplementation fail-first](offline/fail-first.json): ten assertion failures, three controls pass against the exact parent product. The test snapshot is commit `5b0a3fbe7`; [binding](offline/fail-first-binding.json). The final test further strengthens the own-pane case by mounting the actual DetailsPanel instead of the header fixture. The earlier selector diagnostic is excluded.
- [Final focused receipt](offline/final/receipt.json): 122/122 across nine suites, with one worker, plus native TypeScript 7.0.2 source and test checks. All commands capture a clean Git head/tree before execution. A separate exploratory TypeScript 6 invocation reported existing TS7022/7024 in untouched `runtime-pane-port.ts`; no legacy-compiler success is claimed.
- [Seven semantic reversals](offline/mutations/receipt.json), each syntax-valid and assertion-caught: selected row, different-agent preservation, public View restriction, pane return, actual Settings-to-pane metadata, Settings link and popup link. Exact source restoration followed by the final focused pass. Logs are lossless gzip.
- [Browser verification](browser-verification.json): **20 serial Chromium runs, 87 checkpoints, 42 PNGs**, clean capture-time Git tree/input/harness digests, 380 inputs, 4,057 served-asset bindings and 36 exact retained substitutions. One SSE, no browser errors, external requests or settings writes. Current phone return targets are at least 44 × 44 px and there is no viewport overflow.

The desktop journey uses the real cookie session, HTTP UI, native Enter, same-row click, description staging, Cancel/discard dialog and split-pane return while preserving the peer’s composer. The phone journey exercises the existing single-pane fallback. Scratch FleetManager status/names are fixture data; no Fleet/agent is started, no message sent and no Apply performed. The existing read-only status-emoji preview POST is allowed and recorded. No real account, vendor CLI, AD, pilot or live-fleet operation.

## Before / after

| View | Light | Dark |
|---|---|---|
| Parent UI Settings | [zh-TW](browser/before-desktop-light-zh-TW/light-zh-TW-settings.png) | [zh-TW](browser/before-desktop-dark-zh-TW/dark-zh-TW-settings.png) |
| Settings X | [zh-TW](browser/after-desktop-light-zh-TW/light-zh-TW-settings.png) | [zh-TW](browser/after-desktop-dark-zh-TW/dark-zh-TW-settings.png) |
| Returned Chat | [zh-TW](browser/after-desktop-light-zh-TW/light-zh-TW-returned-chat.png) | [zh-TW](browser/after-desktop-dark-zh-TW/dark-zh-TW-returned-chat.png) |
| Split Settings | [zh-TW](browser/after-desktop-light-zh-TW/light-zh-TW-split-settings.png) | [zh-TW](browser/after-desktop-dark-zh-TW/dark-zh-TW-split-settings.png) |
| Split returned Chat | [zh-TW](browser/after-desktop-light-zh-TW/light-zh-TW-split-returned-chat.png) | [zh-TW](browser/after-desktop-dark-zh-TW/dark-zh-TW-split-returned-chat.png) |
| Phone Settings | [zh-TW](browser/after-phone-light-zh-TW/light-zh-TW-settings.png) | [zh-TW](browser/after-phone-dark-zh-TW/dark-zh-TW-settings.png) |

The same before/current desktop/phone light/dark matrix is recorded for English. A bounded image review inspected the twelve current zh-TW desktop/phone originals listed in [visual-review.md](visual-review.md); no clipping/overlap blocker. Phone titles remain ellipsized and forms continue below the viewport. Stills prove appearance only; behavior is established by the tests and browser checkpoints.

## SKEW and limits

The before control serves all four exact parent UI blobs on the current fixture server, rather than executing an old backend. Four separate controls retain the parent sidebar, Details page, workspace header or popup header. New code imports only already-existing shared exports; the return label self-registers in its lazy page. Optional header metadata lets old Details keep its old header, and an old workspace header retains the honest **Close this pane** action/label. The new sidebar remains a route back to Chat with old Details. No error, invented authority or Settings write is introduced.

The popup-header asset is linked in the root browser graph; actual popup-header rendering/return is covered by the mounted test. No new real browser-window journey, native runtime, previous whole release, alternate browser or live-fleet test is claimed. CSS is unchanged from the parent; its separately disclosed old-CSS menu presentation limit remains parent scope.

Review checklist: ownership/targeting and async navigation (rows 3/5/9) reuse guarded routing and own-pane metadata, pinned by guard/peer/public controls; real inert paths and compiling reversals (11); exact receipts and retained-asset limits (12). No new effect, timer, recovery protocol, dialog grammar, queue or authorization mechanism (other rows N/A). Shared components are InstanceNav, PanelHeader, PaneHeader, PopoutHeader, Icon and the existing router/leave guards. No extra confirmation is added; only an already-dirty Settings form invokes its existing dialog.

Rollback: revert the four UI changes and changelog entries to restore the prior links/header. No state migration or data rollback is needed. Final PR-head CI is required separately from these captured checks.
