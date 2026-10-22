---
section: Fixed
---
- **停止時不再把 tmux 輔助行程留給 systemd 強制結束（#2364）。** 先前 fleet 停止時會關閉它的 tmux 小輔助行程後立刻結束，所以在 systemd unit 底下，這個輔助行程會跟著服務剩下的行程一起被強制終止，系統 unit 還會為它記下「remains running after unit stopped」。現在停止時最多等 2 秒，讓輔助行程自己完成並結束。
