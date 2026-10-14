---
section: Fixed
---
- **在沒有 D-Bus user bus 的 Linux 主機上，`agend update` 不再一律回滾（#1804）。**
  - 在沒有安裝 `dbus-user-session` 的主機上，`systemctl --user` 可以用，但 `busctl --user` 連不上。過去在這種主機上每次更新都會回滾，訊息是「systemd does not know com.agend.fleet.service」，即使服務其實已載入且正在執行。
  - 現在連不上 bus 時，更新改用 `systemctl --user` 檢查服務。只有在 systemd 載入的正是 AgEnD 自己的 unit 檔、且與磁碟上的內容完全一致時才會繼續：沒有 drop-in、沒有待執行的 reload、沒有 `EnvironmentFile=` 或 `PassEnvironment=`。之後照常透過 systemd 重啟。`agend restart` 也做同樣的檢查。
  - 無法證明的情況仍然回滾，訊息會寫出真正的原因：連不到 manager、systemd 不認得這個 unit，或是 unit 無法證明（並說明原因）。回滾訊息也不再在只是讀不到的時候，聲稱還原的 unit 沒有載入。
  - user bus 正常的主機行為不變。
