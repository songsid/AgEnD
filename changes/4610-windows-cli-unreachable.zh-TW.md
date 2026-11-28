---
section: Fixed
---
- **「CLI 診斷 · Windows 本機」會說明為什麼連不到 Windows，而不是 `spawn …powershell.exe ENOENT`。** AgEnD 不是跑在 WSL（容器、一般 Linux 主機），或 WSL 的 interop 關閉、找不到 PowerShell 時，「重新偵測」現在會指出原因與處理方式——改在 Windows／WSL 執行 AgEnD 或配對一台 Windows 電腦、在 `/etc/wsl.conf` 開啟 interop、掛載 `/mnt/c`、安裝 Windows 版 Node.js——有英文與繁體中文。PowerShell 會依序從 PATH、已掛載的磁碟與 `wslpath` 尋找；daemon 自己的工作目錄被刪掉時，也不再無聲失敗。另外，沒有偵測紀錄時，對話框不會再同時宣稱「目前顯示上次成功偵測的結果」。
