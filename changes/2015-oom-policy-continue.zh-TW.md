---
section: Fixed
---
- **單一行程因記憶體不足被 kill，不再讓整個 fleet 停掉（#2015）。** 在 Linux 上，instance 執行的一切都在 fleet 服務的 cgroup 裡。systemd 預設是 `OOMPolicy=stop`：kernel 因記憶體不足 kill 掉一個失控的指令（例如 agent 跑的一次性腳本），就會停掉整個服務，所有 instance 都跟著停，直到 `Restart=` 把它拉起來。現在 unit 設定 `OOMPolicy=continue`，只有被 kill 的那個行程會結束：被 kill 的 CLI 會被當成 crash 重啟，被 kill 的 fleet 行程也仍由 systemd 重新啟動。更新時會重寫 user unit 帶上這個設定；`agend restart` 與更新時的 refresh 也會替舊的 unit 和舊式的 system unit 補上。unit 自己設定了 `OOMPolicy` 的話會保留原值。
