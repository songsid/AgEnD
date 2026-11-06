---
section: Added
---
- **Fleet 管理員現在可以在「設定 → Runtime」從 Dashboard 在已配對的 Windows 電腦上安裝 Claude Code 或 Codex。** 只有在那台電腦的本機管理員開啟 `agend-runtime remote-setup install on [--for 2h]` 時才可使用（預設關閉；Dashboard 只能讀取開關，不能變更）。Dashboard 只送出 CLI 代號：Runtime 會從官方 npm registry 安裝固定版本，裝在 Runtime 自己的資料夾（不需系統管理員、不改 PATH、不執行廠商腳本），並且要 npm 完整性檢查、程式內寫死的 registry 雜湊、`npm audit signatures` 與 Windows 發行者數位簽章（憑證的 CN 與 O 都要完全相等）全部通過才會啟用，整個流程共用 10 分鐘的總期限。同一版本已安裝時不會重做；要換掉舊安裝時，先把舊資料夾移開，換版失敗會放回原位。只支援 x64 的原生 Windows，Windows on ARM 這次不提供。偵測與執行會優先使用已安裝的版本。Grok、Antigravity、Kiro 只顯示官方指令，由電腦的主人自己執行。請求走 AgEnD 不會寫入 journal 的專用訊息，每次安裝都會記錄在那台電腦的 `audit.jsonl`。安裝會取得共用的 Runtime 安裝鎖（與安裝程式、更新相同的那一把），並以標記持有到它啟動的每個程式都確實結束為止，因此手動重裝或更新不會在安裝途中插進來。
