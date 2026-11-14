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

Leader’s forwarded freeze-lift receipt was verified; coordinator alone merges after exact-head review/CI requirements.

## R1: new Settings select tap size

CI ui-gate on the first head reported `phone-dark-zh-TW:preferences:tap` for `select#pref-density`. Local `SECTIONS=preferences GATE=ci` reproduced the same failure. The inherited preference select height was below the 44 px minimum; the older language/name controls have legacy allowances. No allowance was added or changed.

The new density control alone now has `min-height: var(--tap)` on phone/coarse input. Compact agent rows remain 30/40 px. The unrelated cosmetic validator-comment placement was corrected in this same delta.

- `REPO="$PWD" PW_DIR="$PWD" OUT="$PWD/.artifacts/ui-gate-density-after" GATE=ci GATE_PORT=47960 npx tsx scripts/manual/smoke/smoke-settings-ui-gate.mts` — **114/114 checks pass**, all Settings sections, desktop light English + phone dark zh-TW and 1024 px overflow checks. [Result](ui-gate-r1.json).
- `REPO="$PWD" PW_DIR="$PWD" npx tsx docs/evidence/sidebar-density-3129/settings-control.mts` — scoped real fixture capture after scrolling the control into view: **324 × 44 px**. [Measurement](settings-control.json), [phone Settings PNG](phone-preferences-r1.png).
- No JS behavior or row rendering changed in R1; prior unit/type/sidebar PNG evidence carries. Both fixture browser/server lifecycles close after the run.
