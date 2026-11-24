# Fleet › Tasks on a phone: every toolbar control a full tap target (M-3610)

Found in the #4394 capture check, and older than that PR: on a 390 px phone, several Fleet › Tasks controls were below the 44 px tap target.

| Control | Before (px high) | After |
|---|---|---|
| Home: the search box | 36 | 44 |
| Home: Instances, New project | 36 | 44 |
| Home: a project tile's ⋯ | 36 × 36 | 44 × 44 |
| A project: Back | 30 | 44 |
| A project: Stats | 26 | 44 |
| A project: Instances, New main task | 36 | 44 |
| A project: its search box | 30 | 44 |

The Fleet tab pills were already 44 px on a phone. The rule pins them too.

The fix is CSS only, under the phone and coarse-pointer query (`max-width: 899px` or `pointer: coarse`), and it uses `--tap`. A desktop with a fine pointer keeps its compact bar.

## Checks

`scripts/manual/smoke/smoke-tasks-phone-tap-m3610.mts` (ui-gate, HP 19761) runs headless Chromium on the smoke fixture. Each case gets an empty board of its own with one made-up project and card, and is reached through visible UI (Fleet, then the Tasks tab).

- **Phones** (zh-TW light, en dark): every control above is at least 44 px high (icon buttons at least 44 px wide too), on the home page and in the project.
- **Desktop** (en light): the same controls stay under 44 px, so the desktop is unchanged.
- **Every case:** no sideways scroll and no page errors.

Results:
- **This branch:** all 3 cases pass (`result.json`).
- **The base branch:** the same smoke fails "all ≥44 px" on both phones, home and project (`before-result.json`, `before-*.png`).

| | Before (base) | After |
|---|---|---|
| Phone, zh-TW, light | `before-phone-light-zh-TW-1-home.png`, `before-phone-light-zh-TW-2-project.png` | `phone-light-zh-TW-1-home.png`, `phone-light-zh-TW-2-project.png` |
| Phone, en, dark | `before-phone-dark-en-1-home.png`, `before-phone-dark-en-2-project.png` | `phone-dark-en-1-home.png`, `phone-dark-en-2-project.png` |
| Desk, en, light (unchanged) | — | `desk-light-en-1-home.png`, `desk-light-en-2-project.png` |
