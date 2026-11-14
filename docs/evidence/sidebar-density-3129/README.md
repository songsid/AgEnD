# M-3129: sidebar density, approved v4

The existing sidebar had one detailed rendering. `nav.density` now selects Detailed (default) or Compact in Settings → Preferences, using the existing synced preference Save/Discard lifecycle. Compact changes only presentation: no avatar, the existing status dot/working pulse, name and muted last-reply time. The original row title retains details. Links, favorite menus, filter, groups, sorting and drag handlers are shared.

## Validation

- Fail-first: the four initial new tests failed on the unchanged source (unknown preference, missing Settings control and density action).
- Focused suite: `npx vitest run tests/sidebar-density-3129.test.ts tests/web-prefs-1665.test.ts tests/sidebar-reply-time-2179.test.ts tests/sidebar-names-1722.test.ts tests/web-favorites-1664.test.ts tests/view-sidebar-filter-999.test.ts --maxWorkers=2` — 108/108.
- Settings search/registry and held-preference suites: 33/33.
- Existing preference client and guarded row-navigation suites passed during focused development.
- `npm run typecheck` and `npm run typecheck:tests` — pass.
- `node docs/evidence/sidebar-density-3129/browser.cjs` — four source-rendered desktop/phone × light/dark comparisons; zero page errors. All 11 compact rows measure exactly 30 px desktop / 40 px phone, with no avatar DOM; two working dots retain `pulse`. Selected fill, radius, name font/colour and group labels match detailed. All colours use existing theme tokens.
- All four PNGs inspected: no text collision or horizontal clipping. The footer clips partial rows at the existing scroll boundary.

The browser rig serves the actual private Sidebar component with fake instances (exposed only in its scratch HTTP response), on a loopback port allocated by the OS. No Fleet daemon, user account or vendor CLI runs. Both browser and server close in `finally`. A cached Chromium executable and installed dependencies are required; no downloads occur. The comparison fixes the clock for stable relative times.

| Equal 760 px sidebar | Detailed complete rows | Compact complete rows |
| --- | ---: | ---: |
| Desktop, either theme | 4 | 7 |
| Phone, either theme | 4 | 6 |

## PNGs

- [Desktop light](desktop-light.png)
- [Desktop dark](desktop-dark.png)
- [Phone light](phone-light.png)
- [Phone dark](phone-dark.png)

## Risk and rollback

Presentation and one optional preference only; no instance state, notifications or tool authority changes. Detailed remains the default and its row rendering is retained. Select Detailed to restore the current layout; clearing `nav.density` also restores it. Reverting the feature leaves no data migration to undo.

Alpha gate is held for the beta.3 release freeze. Coordinator alone merges after the freeze and exact-head review/CI requirements.
