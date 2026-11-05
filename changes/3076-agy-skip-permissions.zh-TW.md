---
section: Fixed
---

- **Antigravity 會遵守 `skipPermissions: false`（#3076）。** instance 設成這樣時，啟動不再帶 `--dangerously-skip-permissions`，和其他 CLI 後端一樣。資料夾信任提示仍會自動回答；不會代答逐項核准。
