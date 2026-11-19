# Hub room invitation action copy

Before a press, the shared `RoomPicker` used `invitePending` for an askable
agent and `askOwner` for a findable agent (`src/ui/hub-room-new.js:83`). This
showed a waiting status before an invitation existed. Both non-owned agent
results now use the existing **Ask {owner}** / **請 {owner} 加入** action and
accessible label. The single whole-row button, selection, post-selection tags,
submitted invitation status and authorization remain unchanged. No new strings,
styles, endpoint or stored data are introduced.

This standalone dev change starts at `c35c2740860ac40a16211727735bf32b76d918cb`,
the actual merge of #4205. The design reference is
`docs/design/hub-room-ask-owner-for-agent.md` at `ce56e214e`; that documentation
branch was read, never merged.

## Checks

- `npx vitest run tests/hub-room-discovery-ui-m3341.test.ts -t 'same owner action'`
  first fails both EN and zh-TW controls against the baseline; eight unselected
  tests are excluded. The full updated file then passes 10/10.
- `npx vitest run tests/hub-room-new.test.ts tests/hub-person-picker-m3342.test.ts tests/hub-room-owner-requests-ui-m3341.test.ts`
  passes 29 tests and identifies one old initial-label expectation. Updating
  that expectation preserves the same test's post-selection waiting and
  room/invitation ordering assertions. Its selected rerun passes 1/1, with ten
  unselected tests excluded. The staged union is **40 distinct passing tests**.
- `npm run typecheck:tests` exits 0.
- The owned HTTPS/SQLite/audit Hub rig passes **33 before** and **57 after**
  browser checks. Both invitation paths are exercised after the copy change;
  neither delivers an agent answer or grants one-to-one access.

Receipts and the baseline failure are retained here. The before stage serves
the pinned baseline renderer over the same fixture backend; the after stage
serves the working tree renderer. Receipts record source, working diff and
served asset hashes. Replay the existing rig with `VIEW=action-copy`,
`STAGE=before|after`, an owned `OUT`, Linux `CHROME`, `PW_DIR` and `CJK_FONT`;
the before stage also needs `BASELINE_REF=c35c2740860ac40a16211727735bf32b76d918cb`:

```sh
node --import tsx scripts/manual/hub-room-owner-requests-m3341/discovery-browser.mts
```

## Original views

| View | Before | After action | After pressing both actions |
| --- | --- | --- | --- |
| Desktop EN | [original](before/desk-en-picker.png) | [original](after/desk-en-picker.png) | [original](after/desk-en-invited.png) |
| Desktop zh-TW | [original](before/desk-zh-TW-picker.png) | [original](after/desk-zh-TW-picker.png) | [original](after/desk-zh-TW-invited.png) |
| Phone EN | [original](before/phone-en-picker.png) | [original](after/phone-en-picker.png) | [original](after/phone-en-invited.png) |
| Phone zh-TW | [original](before/phone-zh-TW-picker.png) | [original](after/phone-zh-TW-picker.png) | [original](after/phone-zh-TW-invited.png) |

All 12 originals were opened for inspection. The two initial actions agree,
waiting appears in the submitted rows, phone content fits, and Traditional
Chinese glyphs are legible. The fixtures use synthetic names only. Pixels do
not establish the click target; the UI test and browser presses cover it.

Browser automation was serial and headless in Linux/WSL with an isolated home
and a rig-only certificate. No live Hub, directory, Fleet process, AI account,
model call, Windows window or host trust change was used. Browsers, listener
and temporary homes were closed; the browser slot was released.

Risk is limited to wording: owner labels still come from the existing
projection. Reverting this commit restores the old copy without a migration.
