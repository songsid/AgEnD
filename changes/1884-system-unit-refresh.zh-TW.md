---
section: Fixed
---
- **Linux：用系統 unit 執行的 root fleet，從 2.1 更新後會真的換成 2.2。** 有 `/etc/systemd/system/agend.service` 的主機，以前會裝好 2.2 卻繼續執行 2.1，因為 `agend restart` 拒絕了 unit 裡舊的啟動指令。現在更新會像處理使用者 unit 一樣，把那個 unit 的 `ExecStart` 指向新安裝，其他每一行都不動。(#1884)
