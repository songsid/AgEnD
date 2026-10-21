---
section: Fixed
---
- **Linux：fleet 服務不會再因為 systemd 拒收就緒訊號而每 15 分鐘重啟（#2331）。** fleet 透過 `systemd-notify` 輔助程式回報就緒，
  systemd 只有在 `NotifyAccess=all` 時才會收下。載入了 `main`、`exec` 或完全沒設定（早期 2.0 beta 的 unit、手寫的 system unit、
  殘留的 drop-in）的 unit，會讓 fleet 一直停在 `activating`；啟動逾時改成 15 分鐘之後，systemd 每 15 分鐘就會把它 kill 掉再重啟。
  現在 `agend restart` 和更新會把 `NotifyAccess=all` 寫進 unit、向 systemd 確認實際載入的值、在其他 drop-in 蓋掉它時加上 AgEnD
  自己的 drop-in，並點名殘留的服務檔案。`agend doctor` 會顯示實際載入的 unit（有 system unit 時就看它）和它來自哪些檔案；更新時也不再於 system unit 旁寫入用不到的 user unit。更新到這個版本時，同一次更新就會修好。
  詳見 [cli](cli.zh-TW.md#服務管理-service-management)。
