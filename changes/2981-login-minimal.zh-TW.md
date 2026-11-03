---
section: Changed
---
- **`/login`：一次登入只有一個連結，文字也正確（#2981）。**
  - Claude Code 或 kiro 登入時，不再把服務商的登入網址（claude.ai、AWS）和代碼也貼到聊天室。你打開的 AgEnD 終端已經顯示它們，所以聊天室只有終端連結，存取 token 仍然只私訊給你。Codex 與 Grok 用裝置代碼登入、沒有終端連結，仍會在聊天室貼出連結和代碼。
  - `/login muse` 現在請你在主機上用 muse 自己的指令登入，不再顯示 OpenCode 的 API key 說明。
  - 不帶參數的 `/login` 只用一行簡短文字列出 Antigravity（「請在主機上登入：在那裡執行 `agy`」），不再貼出 `/login agy` 才需要的完整說明。
