---
section: Changed
---
- **`agend doctor` 與 fleet 啟動時會顯示 fleet.yaml 的警告（#1874 後續）。** 以前驗證器的警告只出現在 `agend validate`，手動編輯 fleet.yaml 的人很少會去跑它。例如 AgEnD 會忽略的設定（像 `web.access`），或鎖定的 channel 沒有 `allowed_users`。現在 `agend doctor` 會在 **Fleet** 底下逐條列成 ⚠，fleet 啟動時也會在 `daemon.log` 以 warn 等級各記一次。沒有新增檢查。
