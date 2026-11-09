---
section: Added
---
- **可以在設定 → Runtime 替已配對的 Windows 電腦安裝 OpenCode（#3521）。** OpenCode 加入「安裝 CLI」，和 Claude Code、Codex 一樣的保證：固定版本的 `opencode-ai` npm 套件（1.18.34）與它的兩個 Windows x64 套件，逐一比對 registry 的 sha512，執行 `npm audit signatures`，並檢查程式的 Authenticode 數位簽章（Anomaly Innovations, Inc）；每個使用者各自裝在 Runtime 自己的資料夾，不需要系統管理員、不執行廠商腳本，而且只在那台電腦的主人開啟 `install` 開關時才能安裝。Grok、Antigravity 與 Kiro 仍然只顯示官方指令，頁面現在會寫出**原因**：Grok 的 Windows 程式沒有發行者的數位簽章；Antigravity 的廠商腳本裝的是當下最新版本（有固定版本且已簽章的下載檔，之後會支援）；Kiro 的安裝程式需要系統管理員權限。
