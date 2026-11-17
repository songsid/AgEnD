Compact lists now offer one name: Display name / 暱稱 or Instance name / instance 名稱. The radio choice is shared by desktop and phone; density remains per layout. An unset choice preserves the existing leading-name preference (normally display name), including native rows. Detailed rows and both-name filtering keep their previous behavior. The other name stays in the tooltip and accessible name.

Source: `6703b6f9f9de2e58ddd204ab9baa0918b6cebbce`, based on dev tip `d253f0e5e1cccd548f92a03b7d1f4d3427f21cba`.

Validation:

- Fail-first: the new control assertion fails on the base; seven unrelated cases excluded.
- Focused UI/preferences/CSS: 62/62 across six suites; existing name/navigation/prefs consumers: 76/76 across three suites. Locale plus repeated prefs-client controls: 38/38 across two suites (overlap). After the menu fix, the two affected suites pass 13/13 (overlap).
- Source and test TypeScript programs exit 0.
- Real in-process web HTTP server and preference store, scratch home and inert agents: baseline desktop/phone 10 checks; final desktop and phone 14 checks each. Visible Settings Save is exercised. Synthetic names only; no live Fleet, CLI, chat service or model.
- All five CI smokes using the manual nav reset sites pass: phone avatars, Telegram-style drawer, drawer width, composer/drawer and split density. The serial wrapper was interrupted before the last smoke completed; that smoke was then run alone successfully. Four earlier passes predate the menu-height fix; preference reset logic is unchanged by that fix.
- Settings UI gate: `GATE=full SECTIONS=preferences`, 62 checks. This is the Preferences section over the full device/theme/language matrix and width probes, not the whole Settings gate.
- Ten preferred original PNGs: baseline desktop dark EN and phone light zh-TW; final display name, instance name, Customize and Settings on both. Independent image-only inspection found the first desktop menu clipped its last option; bounded internal scrolling and a browser hit-test fix that. Other rows stay one line. The final images contain generic fixture data.

The initial test harness needed property-based radio lookup in its mini DOM; the browser harness needed to wait for actual agent rows and use the visible Settings Save. Those setup corrections are not product failures. The initial desktop menu clipping was a product finding and is fixed.

The new key is `nav.compactName` (cache `agend_nav_compact_name`). It uses the same host revision, local cache, synchronization and Settings hold/save/discard paths as density. All three manual reset sites also clear it. The smoke is added to CI.

Risk: a larger Customize menu needs its own scroll area. Both options are visible and clickable in the final captures. Rollback removes this cosmetic choice; it changes no agent identity or schema. Clear `nav.compactName` before rollback if restoring the previous name behavior is desired.

Plain sync after the source run: the incoming dev tip changed only unrelated Hub files. All 20 own paths have identical blobs and modes; no local re-verification on that sync. See `sync.json`.

CI later caught the two changelog fragment filenames. R1 renames them without changing content; the local validator changes from two filename errors to 601 fragments OK. Runtime, UI and tests are unchanged. See `ci-r1.md`.
