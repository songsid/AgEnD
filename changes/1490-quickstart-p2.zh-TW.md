---
section: Fixed
---
- **Quickstart「新增允許使用者」：支援 `channels:` 陣列形狀的設定檔。** 當 `fleet.yaml` 使用 `channels:` 陣列形狀時，「新增允許使用者」現在能正確讀取並更新所選連線的 `access.allowed_users`，且不會在檔案中寫入幽靈 `channel:` 鍵。(#1490 P2)
- **Quickstart「覆寫（重新開始）」：覆寫前先備份 `fleet.yaml`。** 覆寫前會原子性地寫出 `fleet.yaml.bak-<時間戳>` 副本，提示文字也會說明備份位置。(#1490 P2)
