---
section: Fixed
---
- **艦隊以系統層服務 `/etc/systemd/system/agend.service` 執行時（root 在 2.1 時代的安裝方式，例如 WSL），從聊天執行 `/update` 又能用了（#2274）。** 之前它會在「準備」階段失敗，顯示「Failed to connect to bus」，因為更新程序一律向使用者的 systemd 要求獨立的 scope。現在系統服務底下的艦隊，會向系統的 systemd 取得更新程序的 scope。
