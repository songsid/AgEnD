# M-3314 (#4157): versioned, cached web files and module preload

## Method

`scripts/manual/smoke/smoke-asset-cache-m3314.mts` runs the real app in a smoke fixture (headless Chromium) with **150 ms of latency on every request** (CDP `Network.emulateNetworkConditions`). That is about the round trip the fixed public link measured in M-3312. A "wave" is a group of module requests; a gap longer than 120 ms (0.8 × the latency) starts a new one.

- `before.json`: the same script, run against the base `release/2.3.5-alpha` (5b100833 + #4152), with its versioning checks stubbed out. Only the counts matter there.
- `after.json`: this branch, every check passing.

## Results

| Load (150 ms latency) | Before: waves / modules | After: waves / modules |
|---|---|---|
| `/ui`, empty cache | 21 / 140 | **1** / 150 |
| Settings, opened from `/ui` | 8 / 67 | **1** / 62 |
| Fleet org chart, opened directly, empty cache | 24 / 173 | **1** / 181 |
| `/ui` reload: modules that went to the network | 140 of 140 | **0** of 150 |

After this change, every module request is versioned (`/assets/v-<V>/…`, `/ui/js/v-<V>/…`) and asked for once. There are no console errors and no CSP violations.

**After an update:** the smoke changes the server's version under the open tab, then opens Needs you, a panel that tab hadn't loaded. The tab shows "This tab is older than AgEnD now." with **Reload this tab** (`after-update-stale.png`) and requests no module under the new version. After Reload, the page boots on the new version.

The re-measure over the real fixed link comes after this ships to the host (M-3312's method). It will be added to this folder then.
