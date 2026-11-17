# Office: idle people stay in their own area (M-3286, #4104)

Source `2d236e9af22c5ac2612478d471fd23198c41697b`, from dev tip `c766694408792c04b26d1a0d5bec079a7483a000`.

**Change.** Edit offices has a per-office box, **Idle people stay in their own area** (待命只在自己的區域走動), off by default. With it on:

- a stroll ends only at a waypoint inside the area the person is seated in (`wanderTarget`'s new `area`);
- the walk there and back, as the walkers draw it (`routeVia`, straightened on a `straight` graph), must stay inside that area. If no spot qualifies, a spot is kept only if its walk crosses no other area's inside: corridors outside every area are fine, and an edge two areas share doesn't count. Otherwise the person stays seated;
- `walkTargets(…, ownArea)` skips `idleVisits`. A walking NPC keeps to the area its spot is in.

The host keeps the flag beside the office list (`stayInArea: { "<office id>": true }`), never in the entry: an older host refuses unknown entry keys and would drop the office. Off is no key. The page model and `officeForSave` keep `true` only.

**Fail-first.** `tests/web-office-stay-in-area-m3286.test.ts` (15 tests) against the dev tip's source: 10 fail and the 5 controls pass. With the change: 15/15. Mutations, each caught:

- visits not skipped: 1 red;
- no route check: 2 red;
- the corridor fallback checking corners only: 1 red;
- spots not limited to the area: 2 red;
- the NPC's area not found: 1 red.

**Related suites.** 49 Office files (837 tests) and 51 docs, skill and changelog files (1,633 tests) all pass, as do the CI workflow tests (9 files, 393 tests), `typecheck` and `typecheck:tests`.

**Real app (headless Chromium, smoke fixture, no fleet started).** `scripts/manual/smoke/smoke-m3286-office-stay-in-area.mts`, added to the CI UI gate at HP 19693. Desk light en and desk dark zh-TW, both pass:

1. Fleet → Org chart → Office → Edit offices → Add office (Cozy). The box is off by default, with the expected label.
2. Tick it and Save. `GET /ui/offices` has `stayInArea: true`; `web-offices.json` has it in the map beside the list and in no entry.
3. Open the office, then Edit offices again: it's still ticked.
4. Untick and Save: the key is gone from the API and the file.

There is no page overflow and there are no page errors. Images:

- `desk-light-en-1-edit-ticked.png`, `desk-dark-zh-TW-1-edit-ticked.png`: the box ticked;
- `desk-light-en-2-office.png`: the office;
- `*-3-reopened.png`: reopened. The zh-TW case shares the fixture, so the earlier Tavern (now unticked) sits beside 酒館 (ticked).

The people and teams are the fixture's synthetic data.

**Rollback.** A plain revert. A file written with the flag stays readable by any older host, which drops the flag on its next save.
