---
section: Fixed
---
- 更新會採用實際重啟結果：pending 回傳 exit 75 並保留修復備份；啟用失敗回傳 exit 1，不再回報成功（#1490）。Systemd 啟動失敗時，只有載入／磁碟 ownership 未變且確認服務已停止，才可還原本次更新的套件與 unit 備份；啟動前會核對舊的載入目標，回復成功仍回報本次更新失敗。Unknown／變更的 owner 與 detached 失敗需要管理者檢查。System-source Node 不符時會說明 user unit、system unit 與 launchd 的修復方法，並保留既有 restart 核對。
