---
section: Changed
---
- **測試：`ENGINES` 常數必須在 `package.json`、`scripts/preinstall-guard.cjs` 和 `src/node-version-guard.ts` 之間保持同步。** 新測試以 `package.json` 的 engines.node 為唯一真實來源，並斷言：(a) `preinstall-guard.cjs` 的 `ENGINES` 字串與其完全相同，(b) `isNodeCompatible()` 對每個選擇項的最低版本都回傳 true。任何一處有變動而其他處未更新時，測試就會變紅。(#1490 P3)
