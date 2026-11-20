Copy follow-up to #4296 (M-3494)

The shared chat strings now say “Agent details”, “Start agent”, “Restart agent”, “Stop agent” and “Delete agent…”. The stopped-message recovery hint names the same Start action. The zh-TW phone sheet says 「CLI 後端」. Shared string keys, callbacks, permissions and layout are unchanged; Details and Windows agent controls use the same translated labels.

Both UI style guides §11 retain Agent/Fleet as product terms in Chinese. The existing English “New agent” and phone “Agent details” establish the same vocabulary; the guide does not prohibit the technical word instance everywhere, so this change stays on these menu labels and the matching recovery instruction.

- [Desktop EN](desk-light-en-sidebar.png)
- [Phone zh-TW, long-press](phone-dark-zh-TW-sidebar.png)

Source: current working patch based on dev merge21cd6621. Reproduction: `MATRIX=quick` with `scripts/manual/smoke/smoke-sidebar-context-menu-m3485.mts`, the owned scratch FleetManager and headless Chromium. Synthetic Example Alpha/Beta only. The two cases compare header/sidebar actions and assert focus, target, favorites/cache, unchanged route, no overflow/clipped menu/CSP/page errors/unexpected writes. The English case also retains selected-target Split proof. No live account/provider/lifecycle operation or physical-phone/Safari claim.

Validation: seven affected mounted/terminology suites pass90/90. The localized backend assertion is inside the existing command/late-response test; English expected-action lists were updated where the shared strings appear. An attempted second parameterized execution reused a pending model command from its first execution; the test now checks locale rerender within its existing isolated command flow. No production behavior changed to accommodate a test. Changelog validation and test type-check (exit0) pass. Image inspection confirms the shown labels have no clipping or broken glyphs; the phone’s lower actions after Stop Agent lie outside this still image, so those are not visually claimed. Original broad interaction and mutation campaigns from #4296 were not repeated.

Rollback: revert these string changes and matching expected labels. No data migration or authorization change.
