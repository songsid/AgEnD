Guest sidebar controls and account preferences

Source `96cbbceef84e03696b1f6b280d859ae197733c22`, from dev tip `83afcc0565cbc95af7fd2e8f197b7ad36eb2aa9e`.

Root cause: the dev tip already renders the desktop guest's filter and sort controls. Its guest sidebar at `src/ui/shared/app-shell.js:438` lacks the `fleet-side` layout class: `app.css:1661` hides the phone Custom control, while `app.css:4790` enables it only under that class. The density and compact-name keys are also absent from both guest-owned lists (`src/web-prefs.ts:79`, `src/ui/shared/app-prefs.js:114`), so the client does not save them and the server refuses such a write.

Reuse the existing sidebar and controls over the guest's projected roster. Add the three existing density/name keys to the guest's account bucket, keeping desktop and phone density separate and the compact-name choice shared. No new preference key or storage key is introduced. Existing smoke resets already clear these keys; guest removal now clears them through the expanded own-key list. Admin write rules and navigation remain unchanged. A small shared-header wrap prevents a long Recent replies button from crowding the heading.

Verification:

- Baseline: three assertion failures (phone layout, client write permission, actual server write), six positive controls. The first locale helper incorrectly toggled an already-open menu; that harness failure is excluded after correction.
- Final focused run: 57/57 across six suites, including guest/admin DOM, actual preferences handlers with bound gateway requests, the real store, existing public-link isolation, phone drawer and compact-name controls. Source/test native TypeScript exit 0. The subsequent CSS-only wrap is covered by the focused browser retake.
- Before: four desktop/phone admin/guest cases, 18 checks. After: all four cases pass, 32 checks across one completed case and three remaining cases after a reload-roster wait was corrected. These mount/drawer waits are harness fixes, not product failures or semantic reds.
- Image review found a crowded desktop heading. The wrap fix passes a focused three-case retake with 29 checks, including actual control rectangles that do not overlap. Two closed-menu guest views show only `agent-beta` after filtering by Beacon. The prior phone-admin view carries because the changed desktop header is hidden there.
- Guest choices survive reload; writes are 200, host preferences are unchanged, a second guest inherits none, ungranted rows and admin controls remain absent, and unknown host-only keys stay refused. Existing EN/zh-TW labels are reused. The new smoke runs in CI at unique HP 19677.

Preferred views are the ten `before-*` / `after-*` PNGs. The old crowded heading is retained separately as historical. Independent image-only review inspected all eight initial originals and five retakes; the final preferred views have no new layout or privacy issue. The menu's scroll behavior is exercised by actual radio selection, not inferred from a still image.

The browser fixture uses the real web HTTP, sessions, preferences and DOM, with synthetic people and inert agents. Public-link writes are proven through actual handlers with an injected gateway binding, not a live tunnel. No live Fleet, Discord, directory, CLI or pane is used. All browser runs are headless in WSL. Owned browsers and listeners closed and the slot was released. Logs are losslessly gzip-compressed after local paths are replaced; the manifest binds 16 inputs and 23 artifacts.

Commands: run `node node_modules/vitest/vitest.mjs run` with the two new M-3280 test files plus `web-prefs-1665`, `web-guest-prefs-public-1920`, `sidebar-phone-drawer-3212` and `sidebar-compact-name-m3269`, with `--maxWorkers=2`. Run the native TypeScript binary against `tsconfig.json` and `tsconfig.test.json`. The smoke is `scripts/manual/smoke/smoke-guest-sidebar-m3280.mts`; `STAGE=before` captures the baseline, and optional `CASES` selects affected retakes.

Risk and rollback: older clients keep their previous behavior. An ordinary revert restores the prior UI and guest write list; the added values are existing registry keys confined to the guest bucket. No migration or host-setting change is required.
