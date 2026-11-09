---
section: Added
---
- **在設定頁把已安裝的 AI CLI 更新到 AgEnD 稽核過的版本（#3521）。** 設定 → Agents →「AI 帳號與 API 金鑰」裡，已安裝的 CLI 現在會顯示自己的版本，以及 AgEnD 稽核過的最新版本。版本較舊時，那一列有「更新到 \<版本\>」：它在 `/login` 與「安裝」按鈕共用的同一個安裝視窗裡，執行該 CLI 官方安裝程式並固定在那個版本（Claude Code、Codex、OpenCode、Grok、Kiro）——同一時間只有一個、可以取消，結束時顯示更新前後的版本，或安裝程式的結束碼與最後幾行。它不會更新到「最新釋出版」。會在背景自己更新的 CLI（Antigravity、Muse）只顯示兩個版本，沒有按鈕；比稽核版本還新的會寫「尚未經 AgEnD 驗證」。設定 → Runtime 裡，Windows 電腦上較舊的 Claude Code 或 Codex 會有「更新到 \<版本\>」，也就是同一套固定版本的安裝，並保留 Windows 安裝的所有檢查（確切版本、雜湊、registry 簽章、發行者簽章）；固定版本已移到最新的稽核版本（Claude Code 2.1.318、Codex 0.166.0）。頁面只送出 CLI 的 id；誰可以更新，與誰可以安裝相同。
