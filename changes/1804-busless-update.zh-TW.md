---
section: Fixed
---
- **在沒有 D-Bus user bus 的 Linux 主機上，`agend update` 不再一律回滾（#1804）。**
  - 在沒有安裝 `dbus-user-session` 的主機上，`systemctl --user` 可以用，但 `busctl --user` 連不上。過去在這種主機上每次更新都會回滾，訊息是「systemd does not know com.agend.fleet.service」，即使服務其實已載入且正在執行。
  - 現在連不上 bus 時，更新改經由 systemd 的 private socket 詢問——也就是 `systemctl --user` 在這類主機上使用的同一個連線。它讀到的定義和經由 bus 讀到的完全相同，因此重啟前做的檢查也完全一樣，之後照常透過 systemd 重啟。`agend restart` 也一樣。
  - 仍無法證明的情況照樣回滾，訊息會寫出真正的原因：完全連不到 systemd、systemd 不認得這個 unit、systemd 拒絕了請求，或是 unit 啟動的不是新安裝的版本。回滾訊息也不再在只是讀不到的時候，聲稱還原的 unit 沒有載入。
  - user bus 正常的主機行為不變。
  - **這類主機需要手動一次。** 更新到這個版本時，檢查仍由正在執行的舊版本進行，所以從 2.2.0-beta.9 或更早版本更新會再回滾一次。請自行執行 `npm i -g @songsid/agend@beta` 安裝這個版本，再執行 `agend restart`；重啟會使用新的檢查。之後的更新就會正常進行。
