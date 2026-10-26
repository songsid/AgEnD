---
section: Fixed
---
- Windows 安裝程式不再在 AI 後端裝好後誤報「全部安裝失敗」：送進 WSL 的指令改用 `wsl --exec`，原樣到達 Linux（之前會被發行版的 shell 改寫）。接續安裝時會列出上次選的後端：按 Enter 沿用，或輸入新的清單（#2718、#2720）。
- 主控台登入改用 Start-Process 在 Windows 的瀏覽器打開登入頁；explorer.exe 曾把它開成「文件」資料夾，只在最後才用。Codex 改用裝置碼登入（`codex login --device-auth`），不再依賴 WSL 轉送 localhost。
- 設定開始前，安裝程式會找兩個相鄰、在 Windows（沒被保留、沒有程式在聽，包括另一個 Linux 的 WSL 轉送）和 Linux 裡都能用的連接埠，交給 AgEnD 當 `health_port`（儀表板與設定頁）和 `health_port`+1（預覽）；等 Windows 連得到設定頁才打開它。
