---
section: Fixed
---
- Linux 服務內的聊天更新會使用獨立的同使用者 systemd scope，避免 fleet 停止時把 updater 一併清除（#1490）。Cgroup 狀態不明或 scope 啟動不可用時會拒絕並提示從主機 shell 恢復。保留安裝路徑驗證、環境、工作目錄與兩秒延遲；憑證不會放進命令參數。
